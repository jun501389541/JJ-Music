<script setup lang="ts">
/**
 * 音源管理 — import, inspect and troubleshoot LX-compatible source scripts.
 *
 * This is the compatibility surface with the LX Music ecosystem, so it exposes
 * what users actually need when a source misbehaves: which platforms a script
 * advertises, which qualities survived the host's filtering, and the script's
 * own console output.
 */
import { useUiStore } from '../stores/ui'
import { computed, ref } from 'vue'
import type { UserApiMeta } from '@shared/types'
import type { ValidationReport } from '@shared/validation'
import { QUALITY_LABELS } from '@shared/types'
import { useLibraryStore } from '../stores/library'
import { useToastStore } from '../stores/toast'

const library = useLibraryStore()
const ui = useUiStore()
const toast = useToastStore()

const pasting = ref(false)
const pasteText = ref('')
const pasteName = ref('')
const pasteUrl = ref('')
const importing = ref(false)
const logsFor = ref<string | null>(null)
const logs = ref<string[]>([])
/** Reports that caused a refusal, kept visible until the user dismisses them. */
const blockedReports = ref<Record<string, ValidationReport>>({})
/** True while a batch enable is running, so the button cannot be double-fired. */
const batching = ref(false)
const verifying = computed(() => Object.values(library.platformHealth).some(item => item.status === 'checking'))
const statusLabel = { checking: '验证中', available: '抽测通过', failed: '验证失败', unknown: '未能验证' }
function healthDetails(id: string): string {
  const health = library.platformHealth[id]
  if (!health) return '等待音源启动后验证'
  return [health.message, 'sample' in health ? health.sample : '', 'checkedAt' in health ? `验证时间：${new Date(health.checkedAt).toLocaleTimeString()}` : ''].filter(Boolean).join('\n')
}

/** Labels for the heuristic risk rating shown on each imported script. */
const RISK_LABEL: Record<string, string> = {
  low: '风险低',
  medium: '风险中',
  high: '风险高'
}

async function importFromFile(): Promise<void> {
  importing.value = true
  try {
    const result = await library.importSourceFile()
    if (result && result.length > 0) {
      toast.success(`成功导入 ${result.length} 个音源脚本`)
    }
  } catch (error) {
    toast.error(error instanceof Error ? error.message : '导入失败')
  } finally {
    importing.value = false
  }
}

async function importFromPaste(): Promise<void> {
  const payload = pasteText.value.trim()
  if (!payload) return
  importing.value = true
  try {
    const meta = await library.importSource(payload, pasteName.value.trim() || undefined)
    toast.success(`已导入「${meta.name}」`)
    pasteText.value = ''
    pasteName.value = ''
    pasting.value = false
  } catch (error) {
    toast.error(error instanceof Error ? error.message : '导入失败')
  } finally {
    importing.value = false
  }
}

/**
 * Import a script from a link the user pasted.
 *
 * The fetch happens in the main process under the same per-hop guard the app uses
 * for every caller-supplied URL, so a link that redirects to a local proxy or the
 * cloud metadata address fails here rather than succeeding quietly. The script
 * still lands disabled and unvalidated until the user starts it.
 */
async function importFromUrl(): Promise<void> {
  const url = pasteUrl.value.trim()
  if (!url) return
  importing.value = true
  try {
    const meta = await library.importSourceUrl(url)
    toast.success(`已导入「${meta.name}」`)
    pasteUrl.value = ''
    pasting.value = false
  } catch (error) {
    toast.error(error instanceof Error ? error.message : '导入失败')
  } finally {
    importing.value = false
  }
}

/**
 * Enable / disable a source.
 *
 * Validation is part of the start flow, not a separate action: the user pressed
 * "start", so the check runs automatically and its outcome determines whether
 * the source actually starts. There is deliberately no separate "validate"
 * button — a check the user has to remember to run is a check that will not be
 * run.
 *
 * Every exit path ends by re-reading the authoritative list, because the switch
 * reflects what the *app* decided, not what the user clicked. Reporting
 * "已启用" for a source the engine refused to start was the state-desync bug.
 */
async function toggle(api: UserApiMeta): Promise<void> {
  try {
    const result = await library.toggleSource(api.id, !api.enabled)

    // A refused start. Show the findings and leave the switch off.
    if (!api.enabled && result && result.started === false) {
      if (result.report) {
        blockedReports.value = { ...blockedReports.value, [api.id]: result.report }
      }
      const first = result.report?.findings.find(f => f.severity === 'block')
      toast.error(first ? `已拒绝启动：${first.title}` : '启动前校验未通过，已拒绝启动')
      return
    }

    // Started successfully, but the script carried warnings. Report them after
    // the fact rather than gating on them: the user already asked to start it,
    // and a confirmation dialog on every enable would train them to click
    // through dialogs without reading.
    if (result?.report && !result.report.clean) {
      const warnings = result.report.findings.filter(f => f.severity === 'warn')
      if (warnings.length > 0) {
        toast.success(`已启用「${api.name}」（校验有 ${warnings.length} 项提示）`)
        blockedReports.value = { ...blockedReports.value, [api.id]: result.report }
        return
      }
    }

    toast.success(api.enabled ? `已停用「${api.name}」` : `已启用「${api.name}」`)
  } catch (error) {
    toast.error(error instanceof Error ? error.message : '操作失败')
  } finally {
    // Always reconcile with the main process. On a refusal the store's own
    // refresh never runs (it is skipped when the call reports no start), and on
    // an error the optimistic switch position is wrong — either way the list
    // must be re-read so the UI cannot claim a state the engine is not in.
    await library.refreshSources().catch(() => undefined)
  }
}

async function reload(api: UserApiMeta): Promise<void> {
  try {
    await library.reloadSource(api.id)
    toast.success(`已重新加载「${api.name}」`)
  } catch (error) {
    toast.error(error instanceof Error ? error.message : '重新加载失败')
  }
}

async function remove(api: UserApiMeta): Promise<void> {
  if (!await ui.confirm('删除音源', `确定删除音源「${api.name}」？`)) return
  try {
    await library.removeSource(api.id)
    toast.success('已删除')
  } catch (error) {
    toast.error(error instanceof Error ? error.message : '删除失败')
  }
}

async function showLogs(api: UserApiMeta): Promise<void> {
  if (logsFor.value === api.id) {
    logsFor.value = null
    return
  }
  logsFor.value = api.id
  try {
    logs.value = await window.jj.sources.logs(api.id)
  } catch {
    logs.value = []
  }
}

/** Lift a safety quarantine after the user has reviewed the reason. */
async function clearQuarantine(api: UserApiMeta): Promise<void> {
  const confirmed = await ui.confirm(
    '解除隔离',
    `「${api.name}」因安全原因被自动隔离并停用。\n\n` +
      `原因：${api.lastError || '未知'}\n\n` +
      `解除隔离只会让它重新可被启用，不会自动启动它。请确认你信任该脚本的来源。`
  )
  if (!confirmed) return
  try {
    await library.clearSourceQuarantine(api.id)
    toast.success(`已解除「${api.name}」的隔离，可手动启用`)
  } catch (error) {
    toast.error(error instanceof Error ? error.message : '操作失败')
  }
}

function qualityText(qualitys: string[]): string {
  return qualitys.map((quality) => QUALITY_LABELS[quality] ?? quality).join(' · ')
}

function dismissBlocked(id: string): void {
  const next = { ...blockedReports.value }
  delete next[id]
  blockedReports.value = next
}

/**
 * Enable every disabled source, validating each one separately.
 *
 * ## Why this is sequential and goes through the single-source call
 *
 * It would be simpler to add a "start everything" IPC that skips the per-source
 * work, but that would create a path around the start gate — and the gate is
 * the only thing standing between a user and the source that shuts the machine
 * down. So the batch loops over the *same* `toggleSource` call the switch uses:
 * every script is validated on its own merits, every refusal is reported, and
 * there is no code path where "enable all" means "skip the checks".
 *
 * Sequential rather than parallel because each start forks a process, and
 * because the resulting summary is far easier to read when the order is stable.
 * `startAll` inside the engine is already concurrency-limited for the same
 * first reason.
 */
async function enableAll(): Promise<void> {
  const targets = library.userApis.filter((api) => !api.enabled && !api.quarantined)
  const skipped = library.userApis.filter((api) => api.quarantined)

  if (targets.length === 0) {
    toast.success(
      skipped.length > 0
        ? `没有可启用的音源（${skipped.length} 个处于隔离状态）`
        : '所有音源都已启用'
    )
    return
  }

  const confirmed = await ui.confirm(
    '批量启用音源',
    `将依次启用 ${targets.length} 个音源，每个都会单独执行启动前校验。\n\n` +
      (skipped.length > 0 ? `${skipped.length} 个已隔离的音源会被跳过。\n\n` : '') +
      '未通过校验的音源会被自动拦截并隔离，不会启动。是否继续？'
  )
  if (!confirmed) return

  batching.value = true
  let started = 0
  const refused: string[] = []

  try {
    for (const api of targets) {
      try {
        const result = await library.toggleSource(api.id, true)
        if (result?.started === false) {
          refused.push(api.name)
          if (result.report) {
            blockedReports.value = { ...blockedReports.value, [api.id]: result.report }
          }
        } else {
          started += 1
        }
      } catch (error) {
        // A quarantined source throws rather than returning a report; treat it
        // as a refusal rather than letting it abort the whole batch.
        refused.push(api.name)
        void error
      }
    }
  } finally {
    batching.value = false
    await library.refreshSources().catch(() => undefined)
  }

  if (refused.length === 0) {
    toast.success(`已启用 ${started} 个音源`)
  } else {
    toast.error(
      `已启用 ${started} 个，${refused.length} 个被拦截：${refused.join('、')}`
    )
  }
}

/**
 * Stop every enabled source.
 *
 * Runs through the same single-source toggle as the switch, for the same reason
 * the batch start does: one code path, no shortcut around per-source handling.
 * Stopping needs no validation, so this is quick, but it is still sequential
 * because each stop tears down a child process and awaits its exit.
 */
async function disableAll(): Promise<void> {
  const targets = library.userApis.filter((api) => api.enabled)

  if (targets.length === 0) {
    toast.success('所有音源都已停用')
    return
  }

  const confirmed = await ui.confirm(
    '全部关闭音源',
    `将停用 ${targets.length} 个已启用的音源。正在播放的在线歌曲会停止。是否继续？`
  )
  if (!confirmed) return

  batching.value = true
  let stopped = 0

  try {
    for (const api of targets) {
      try {
        await library.toggleSource(api.id, false)
        stopped += 1
      } catch {
        // A single failed stop must not abort the rest; the final refresh will
        // reconcile whatever is still running.
      }
    }
  } finally {
    batching.value = false
    await library.refreshSources().catch(() => undefined)
  }

  toast.success(`已停用 ${stopped} 个音源`)
}
</script>

<template>
  <div class="view">
    <header class="view__header">
      <div>
        <h1 class="view__title">音源管理</h1>
        <p class="view__subtitle">
          导入 LX Music 格式的 <code>.js</code> 音源脚本，即可在线搜索与播放
        </p>
      </div>
      <div class="actions">
        <!--
          Batch enable. Offered because imported scripts now start disabled, so
          restoring a library means flipping many switches. It deliberately
          reuses the per-source start path instead of a bulk IPC: every script
          is validated on its own, and a refusal is reported rather than
          skipped.
        -->
        <button
          class="btn"
          type="button"
          :disabled="batching || importing"
          :title="`为 ${library.userApis.filter(a => !a.enabled && !a.quarantined).length} 个未启用的音源逐个校验并启用`"
          @click="enableAll"
        >
          <span v-if="batching" class="spinner" />
          <span v-else>全部启动</span>
        </button>
        <button
          class="btn"
          type="button"
          :disabled="batching || importing"
          :title="`停用 ${library.userApis.filter(a => a.enabled).length} 个已启用的音源`"
          @click="disableAll"
        >
          全部关闭
        </button>
        <button class="btn" type="button" @click="pasting = !pasting">粘贴导入</button>
        <button class="btn btn--primary" type="button" :disabled="importing" @click="importFromFile">
          <span v-if="importing" class="spinner" />
          <span v-else>选择文件</span>
        </button>
      </div>
    </header>

    <!-- paste import -->
    <section v-if="pasting" class="paste card">
      <div class="paste__row">
        <input
          v-model="pasteUrl"
          class="input"
          type="url"
          aria-label="音源链接"
          placeholder="粘贴音源链接：http(s)://… （.js 或 LX 导出的 .json）"
        />
        <button class="btn" type="button" :disabled="!pasteUrl.trim() || importing" @click="importFromUrl">
          <span v-if="importing" class="spinner" />
          <span v-else>从网址导入</span>
        </button>
      </div>
      <input
        v-model="pasteName"
        class="input"
        placeholder="音源名称（可选，留空则读取脚本头部）"
      />
      <textarea
        v-model="pasteText"
        class="paste__area"
        placeholder="在此粘贴音源脚本内容（支持明文 JS，也支持 LX 导出的 gz_ 编码内容）"
        spellcheck="false"
      />
      <div class="paste__actions">
        <button class="btn btn--primary" type="button" :disabled="!pasteText.trim()" @click="importFromPaste">
          导入
        </button>
        <button class="btn btn--ghost" type="button" @click="pasting = false">取消</button>
      </div>
    </section>

    <!-- empty state -->
    <div v-if="library.userApis.length === 0" class="empty">
      <span class="empty__title">还没有导入任何音源</span>
      <span class="empty__hint">
        JJ Music 本身不内置任何在线音乐平台的播放源。导入一个音源脚本后，即可搜索并解析播放地址。<br />
        你现有的 <code>%APPDATA%\lx-music-desktop\LxDatas\user_api.json</code> 也可以直接选中导入。
      </span>
      <button class="btn btn--primary" type="button" @click="importFromFile">选择音源文件</button>
    </div>

    <!-- script list -->
    <section v-else class="scripts">
      <article v-for="api in library.userApis" :key="api.id" class="script card">
        <div class="script__head">
          <div class="script__id">
            <h2 class="script__name">{{ api.name }}</h2>
            <span v-if="api.version" class="script__version">v{{ api.version }}</span>
            <span v-if="api.author" class="script__author">by {{ api.author }}</span>
          </div>

          <div class="script__actions">
            <label class="switch" :title="api.enabled ? '已启用' : '已停用'">
              <input type="checkbox" :checked="api.enabled" @change="toggle(api)" />
              <span class="switch__track"><span class="switch__thumb" /></span>
            </label>
            <button class="icon-btn" type="button" title="重新加载" @click="reload(api)">⟳</button>
            <button class="icon-btn" type="button" title="查看日志" @click="showLogs(api)">≡</button>
            <button class="icon-btn" type="button" title="删除" @click="remove(api)">✕</button>
          </div>
        </div>

        <!--
          Validation panel.

          Doubles as the refusal notice and the "started, but here is what we
          found" notice. Rendered above the quarantine banner because it
          explains the refusal that *caused* the quarantine. Kept on screen
          rather than shown as a toast: the user has to read the findings to
          decide what to do, and a message that disappears after three seconds
          cannot be acted on.
        -->
        <div
          v-if="blockedReports[api.id]"
          class="blocked"
          :class="{ 'blocked--warn': !blockedReports[api.id].blocked }"
        >
          <div class="blocked__head">
            <span class="blocked__badge">
              {{ blockedReports[api.id].blocked ? '已拒绝启动' : '已启动（有提示）' }}
            </span>
            <span>
              <template v-if="blockedReports[api.id].blocked">
                启动前校验发现 {{ blockedReports[api.id].findings.filter(f => f.severity === 'block').length }} 项阻断问题
              </template>
              <template v-else>
                校验发现 {{ blockedReports[api.id].findings.filter(f => f.severity === 'warn').length }} 项需要注意的特征
              </template>
            </span>
          </div>
          <ul class="finding-list">
            <li
              v-for="finding in blockedReports[api.id].findings.filter(f => f.severity !== 'info')"
              :key="finding.id"
              class="finding"
              :class="`finding--${finding.severity}`"
            >
              <strong>{{ finding.title }}</strong>
              <p class="finding__detail">{{ finding.detail }}</p>
              <p class="finding__remedy">{{ finding.remedy }}</p>
            </li>
          </ul>
          <button class="btn" type="button" @click="dismissBlocked(api.id)">知道了</button>
          <p class="validation__caveat">
            校验为静态文本分析，不会运行脚本。混淆脚本的字符串在运行时才解密，因此「通过」不等于绝对安全。
          </p>
        </div>

        <p v-if="api.description" class="script__desc">{{ api.description }}</p>

        <a
          v-if="api.homepage"
          class="script__link"
          :href="api.homepage"
          target="_blank"
          rel="noreferrer noopener"
        >
          {{ api.homepage }}
        </a>

        <!-- Risk rating. Shown because a source runs third-party code with real
             privileges, and a high rating means we could not tell what it does
             — which is worth knowing before enabling it. -->
        <div v-if="api.risk" class="risk" :class="`risk--${api.risk}`">
          <span class="risk__badge">{{ RISK_LABEL[api.risk] }}</span>
          <ul v-if="api.riskNotes?.length" class="risk__notes">
            <li v-for="(note, index) in api.riskNotes" :key="index">{{ note }}</li>
          </ul>
        </div>

        <!--
          Quarantine banner.

          Shown above everything else because it explains why the switch is off
          and cannot be turned back on: the app disabled this source for safety,
          not the user. The reason is spelled out and clearing it is an explicit
          action, so re-enabling a dangerous script takes two deliberate steps.
        -->
        <div v-if="api.quarantined" class="quarantine">
          <div class="quarantine__head">
            <span class="quarantine__badge">已隔离</span>
            <span class="quarantine__title">此音源已被自动停用</span>
          </div>
          <p class="quarantine__reason">{{ api.lastError || '脚本行为异常' }}</p>
          <button class="btn quarantine__action" type="button" @click="clearQuarantine(api)">
            我了解风险，解除隔离
          </button>
        </div>

        <!-- Failure detail. When a script kills its own process this is where the
             user learns why, since the app itself survived. -->
        <p v-if="api.lastError && !api.quarantined" class="script__error">
          初始化失败：{{ api.lastError }}
        </p>

        <div v-if="logsFor === api.id" class="logs">
          <div v-if="logs.length === 0" class="logs__empty">暂无日志输出</div>
          <pre v-for="(line, index) in logs.slice(-40)" v-else :key="index" class="logs__line">{{ line }}</pre>
        </div>
      </article>
    </section>

    <!-- available platforms -->
    <section v-if="library.sources.length > 0" class="platforms">
      <div class="platform-section-head"><h2 class="section__title">音源声明的平台</h2><button class="btn" :disabled="verifying" @click="library.recheckPlatforms()">{{ verifying ? '正在验证…' : '重新验证平台' }}</button></div><p class="platform-hint">启动音源后自动验证播放地址和音频数据；结果是样本抽测，不保证所有歌曲可播。</p>
      <div class="platform-list">
        <div v-for="source in library.sources" :key="source.id" class="platform card">
          <div class="platform__head">
            <span class="platform__name">{{ source.name }}</span>
            <span class="platform-status" :class="library.platformHealth[source.id]?.status || 'unknown'" :title="healthDetails(source.id)" role="status"><i/>{{ statusLabel[library.platformHealth[source.id]?.status || 'unknown'] }}</span>
          </div>
          <p class="platform-result" :title="healthDetails(source.id)">{{ library.platformHealth[source.id]?.message || '等待验证' }}</p>
          <div class="platform__qualities">
            {{ source.qualitys.length > 0 ? qualityText(source.qualitys) : '无可用音质' }}
          </div>
          <div class="platform__actions">
            {{ source.id }} · {{ source.actions.join(' · ') }}
          </div>
        </div>
      </div>
    </section>

    <!-- compatibility notes -->
    <section class="notes card">
      <h2 class="notes__title">关于音源兼容性</h2>
      <ul class="notes__list">
        <li>
          自定义音源脚本只能提供<strong>播放地址</strong>、歌词与封面（<code>musicUrl</code> /
          <code>lyric</code> / <code>pic</code>），搜索功能由播放器自身实现。
        </li>
        <li>
          脚本可声明的平台仅限 <code>kw</code>、<code>kg</code>、<code>tx</code>、<code>wy</code>、
          <code>mg</code>、<code>local</code>；音质仅限 <code>128k</code>、<code>320k</code>、
          <code>flac</code>、<code>flac24bit</code>，其余会被自动过滤。
        </li>
        <li>
          单个脚本的初始化超时为 15 秒，单次请求超时为 20 秒，与 LX Music 保持一致。
        </li>
        <li>
          音源脚本仍能访问当前用户的本地文件和网络，请只导入可信来源。Windows 受限令牌会移除关机权限；独立进程用于隔离崩溃。
        </li>
      </ul>
    </section>
  </div>
</template>

<style scoped>
.platform-section-head{display:flex;justify-content:space-between;align-items:center;margin-bottom:10px}.platform-section-head h2{margin:0}.platform-hint{font-size:12px;color:var(--text-secondary);margin-bottom:14px}.platform-status{display:inline-flex;align-items:center;gap:5px;flex:none;border-radius:20px;padding:3px 7px;font-size:10px;background:var(--bg-hover);color:var(--text-secondary)}.platform-status i{width:5px;height:5px;background:currentColor;border-radius:50%}.platform-status.available{color:var(--success);background:#4ade8015}.platform-status.failed{color:var(--danger);background:#ff6b6b15}.platform-status.checking{color:var(--accent)}.platform-status.unknown{color:var(--warning)}.platform-result{color:var(--text-tertiary);font-size:11px;line-height:1.6;margin:10px 0;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}

code {
  font-family: var(--font-mono);
  font-size: 0.92em;
  padding: 1px 5px;
  border-radius: var(--radius-xs);
  background: var(--bg-input);
  color: var(--accent);
}

.actions {
  display: flex;
  gap: 8px;
}

/* ---------------- paste ---------------- */

.paste {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 16px;
  margin-bottom: 20px;
}

.paste__row {
  display: flex;
  gap: 8px;
}

.paste__row .input {
  flex: 1;
  min-width: 0;
}

.paste__area {
  min-height: 150px;
  padding: 10px 12px;
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-md);
  background: var(--bg-input);
  color: var(--text-primary);
  font-family: var(--font-mono);
  font-size: var(--text-sm);
  line-height: 1.55;
  resize: vertical;
  user-select: text;
}

.paste__area:focus {
  outline: none;
  border-color: var(--accent);
}

.paste__actions {
  display: flex;
  gap: 8px;
}

/* ---------------- scripts ---------------- */

.scripts {
  display: flex;
  flex-direction: column;
  gap: 12px;
  margin-bottom: 28px;
}

.script {
  padding: 16px 18px;
}

.script__head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
}

.script__id {
  display: flex;
  align-items: baseline;
  gap: 8px;
  flex-wrap: wrap;
  min-width: 0;
}

.script__name {
  margin: 0;
  font-size: var(--text-md);
  font-weight: 650;
}

.script__version,
.script__author {
  font-size: var(--text-sm);
  color: var(--text-tertiary);
}

.script__actions {
  display: flex;
  align-items: center;
  gap: 4px;
  flex: none;
}

.script__desc {
  margin: 8px 0 4px;
  color: var(--text-secondary);
  line-height: 1.6;
  font-size: var(--text-base);
}

.script__link {
  display: inline-block;
  margin-top: 4px;
  font-size: var(--text-sm);
  color: var(--accent);
  text-decoration: none;
  word-break: break-all;
}

.script__link:hover {
  text-decoration: underline;
}

.script__error {
  margin: 10px 0 0;
  padding: 8px 10px;
  border-radius: var(--radius-sm);
  background: rgba(255, 107, 107, 0.1);
  color: var(--danger);
  font-size: var(--text-sm);
  line-height: 1.5;
}

/* ---------------- pre-flight validation ---------------- */

.blocked {
  margin-top: 12px;
  padding: 12px 14px;
  border-radius: var(--radius-sm);
  border: 1px solid var(--danger);
  background: rgba(255, 107, 107, 0.16);
}

.blocked__head {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 10px;
  font-size: var(--text-sm);
  font-weight: 500;
}

.blocked__badge {
  flex: none;
  padding: 2px 8px;
  border-radius: var(--radius-pill);
  background: var(--danger);
  color: #fff;
  font-size: 11px;
  font-weight: 600;
}

/* A source that started *with* warnings: worth reading, but not an error. */
.blocked--warn {
  border-color: var(--warning);
  background: rgba(255, 193, 7, 0.1);
}

.blocked--warn .blocked__badge {
  background: var(--warning);
  color: #3a2c00;
}

.validation {
  margin-top: 12px;
  padding: 12px 14px;
  border-radius: var(--radius-sm);
  border: 1px solid var(--border-strong);
  background: var(--bg-panel);
}

.validation__head {
  display: flex;
  align-items: baseline;
  gap: 10px;
  flex-wrap: wrap;
  margin-bottom: 10px;
}

.validation__status {
  font-size: var(--text-sm);
  font-weight: 600;
}

.validation__status.is-clean {
  color: var(--success);
}

.validation__status.is-warn {
  color: var(--warning);
}

.validation__status.is-blocked {
  color: var(--danger);
}

.validation__meta {
  font-size: 11px;
  color: var(--text-tertiary);
}

.validation__empty {
  margin: 0;
  font-size: var(--text-sm);
  color: var(--text-secondary);
}

.validation__caveat {
  margin: 10px 0 0;
  padding-top: 8px;
  border-top: 1px solid var(--border-strong);
  font-size: 11px;
  line-height: 1.6;
  color: var(--text-tertiary);
}

.finding-list {
  margin: 0;
  padding: 0;
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.finding {
  padding-left: 10px;
  border-left: 2px solid var(--border-strong);
  font-size: var(--text-sm);
}

.finding--block {
  border-left-color: var(--danger);
}

.finding--warn {
  border-left-color: var(--warning);
}

.finding--info {
  border-left-color: var(--text-tertiary);
}

.finding strong {
  font-weight: 500;
}

.finding__detail {
  margin: 2px 0 0;
  color: var(--text-secondary);
  line-height: 1.6;
  overflow-wrap: anywhere;
}

.finding__remedy {
  margin: 2px 0 0;
  color: var(--text-tertiary);
  font-size: 11px;
  line-height: 1.6;
}

/* ---------------- quarantine ---------------- */

/* Deliberately louder than the ordinary error box: this state means the app
   made a safety decision about the script, and the user cannot undo it by
   flipping the enable switch. */
.quarantine {
  margin-top: 12px;
  padding: 12px 14px;
  border-radius: var(--radius-sm);
  border: 1px solid rgba(255, 107, 107, 0.4);
  background: rgba(255, 107, 107, 0.12);
}

.quarantine__head {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
}

.quarantine__badge {
  flex: none;
  padding: 2px 8px;
  border-radius: var(--radius-pill);
  background: var(--danger);
  color: #fff;
  font-size: 11px;
  font-weight: 600;
}

.quarantine__title {
  font-size: var(--text-sm);
  font-weight: 500;
}

.quarantine__reason {
  margin: 0 0 10px;
  color: var(--text-secondary);
  font-size: var(--text-sm);
  line-height: 1.6;
  white-space: pre-wrap;
}

.quarantine__action {
  font-size: var(--text-sm);
}

/* ---------------- risk rating ---------------- */

.risk {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  margin-top: 10px;
  padding: 8px 10px;
  border-radius: var(--radius-sm);
  font-size: var(--text-sm);
  line-height: 1.6;
}

.risk--low {
  background: rgba(74, 222, 128, 0.08);
}

.risk--medium {
  background: rgba(255, 180, 84, 0.1);
}

.risk--high {
  background: rgba(255, 107, 107, 0.1);
}

.risk__badge {
  flex: none;
  padding: 1px 7px;
  border-radius: var(--radius-pill);
  font-size: var(--text-xs);
  font-weight: 600;
}

.risk--low .risk__badge {
  background: rgba(74, 222, 128, 0.18);
  color: var(--success);
}

.risk--medium .risk__badge {
  background: rgba(255, 180, 84, 0.18);
  color: var(--warning);
}

.risk--high .risk__badge {
  background: rgba(255, 107, 107, 0.18);
  color: var(--danger);
}

.risk__notes {
  margin: 0;
  padding-left: 16px;
  color: var(--text-secondary);
}

.risk__notes li {
  margin-bottom: 2px;
}

/* ---------------- switch ---------------- */

.switch {
  display: inline-flex;
  cursor: pointer;
  margin-right: 4px;
}

.switch input {
  position: absolute;
  opacity: 0;
  width: 0;
  height: 0;
}

.switch__track {
  width: 36px;
  height: 20px;
  border-radius: var(--radius-pill);
  background: var(--border-strong);
  position: relative;
  transition: background var(--dur-fast) var(--ease-out);
}

.switch input:checked + .switch__track {
  background: var(--accent);
}

.switch__thumb {
  position: absolute;
  top: 2px;
  left: 2px;
  width: 16px;
  height: 16px;
  border-radius: 50%;
  background: #fff;
  transition: transform var(--dur-fast) var(--ease-out);
}

.switch input:checked + .switch__track .switch__thumb {
  transform: translateX(16px);
}

/* ---------------- logs ---------------- */

.logs {
  margin-top: 12px;
  padding: 10px 12px;
  max-height: 220px;
  overflow-y: auto;
  border-radius: var(--radius-sm);
  background: var(--bg-input);
  border: 1px solid var(--border-subtle);
}

.logs__empty {
  font-size: var(--text-sm);
  color: var(--text-tertiary);
}

.logs__line {
  margin: 0 0 3px;
  font-family: var(--font-mono);
  font-size: var(--text-xs);
  color: var(--text-secondary);
  white-space: pre-wrap;
  word-break: break-all;
  user-select: text;
}

/* ---------------- platforms ---------------- */

.platforms {
  margin-bottom: 28px;
}

.section__title {
  margin: 0 0 12px;
  font-size: var(--text-md);
  font-weight: 650;
}

.platform-list {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(210px, 1fr));
  gap: 10px;
}

.platform {
  padding: 12px 14px;
}

.platform__head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 6px;
}

.platform__name {
  font-size: var(--text-base);
  font-weight: 600;
}

.platform__key {
  font-family: var(--font-mono);
  font-size: var(--text-xs);
  color: var(--text-tertiary);
}

.platform__qualities {
  font-size: var(--text-sm);
  color: var(--text-secondary);
  line-height: 1.5;
}

.platform__actions {
  margin-top: 6px;
  font-family: var(--font-mono);
  font-size: var(--text-xs);
  color: var(--text-tertiary);
}

/* ---------------- notes ---------------- */

.notes {
  padding: 16px 18px;
}

.notes__title {
  margin: 0 0 10px;
  font-size: var(--text-md);
  font-weight: 650;
}

.notes__list {
  margin: 0;
  padding-left: 18px;
  display: flex;
  flex-direction: column;
  gap: 8px;
  color: var(--text-secondary);
  line-height: 1.65;
}

.notes__list strong {
  color: var(--text-primary);
}
</style>
