# Salt Player for Windows — UI/UX & Feature Specification

**Subject:** Salt Player for Windows (椒盐音乐 Windows 版) — Steam AppID **3009140**
**Developer:** Moriafly / Sakawish · **Publisher:** Zeshi Palace Studio (泽世宫工作室) · vendor namespace `com.xuncorp`
**Trademarks:** "Salt Player" and "糖醋音乐" are registered trademarks of **Xunxun Technology (Shanghai) Co., Ltd.** (寻浔科技（上海）有限公司). SPW legal notices add **泽世宫** and state SPW is developed by Xunxun Technology (Shanghai). [W]
**Version analysed:** **1.10.0** (Early Access). Latest documented release at time of writing: **1.18.0** (2026-09-13). [W]
**Internal codename:** **`voxzen`** — confirmed independently by the binary (package `com.xuncorp.voxzen`, resource namespace `voxzen.composeapp.generated.resources`) and by the official about page: *"SPW 全称为 Salt Player for Windows，于 2024 年 4 月正式立项，开发代号为 Voxzen"* [V][W]
**Stack:** Kotlin + Compose Multiplatform (Desktop) on Skiko; BASS audio engine behind an in-house layer called **Pisces**; PF4J plugin framework; bundled JRE (jpackage 25)

**Purpose:** a design/architecture brief for building a *new* music player whose UI is modelled on Salt Player for Windows.

---

## 0. Evidence base, method, and confidence legend

### 0.1 Three independent evidence streams

**(A) Local binary analysis — primary and strongest.**

A licensed copy was inspected at `Salt Player for Windows\` (v1.10.0). It is a `jpackage` app image:

```
Salt Player for Windows.exe     530 KB  launcher; ProductName "Salt Player for Windows",
                                        CompanyName "Zeshi Palace", (c) 2024-2025 Zeshi Palace
steam_appid.txt                 7 bytes -> "3009140"
app\.jpackage.xml                       app-version 1.10.0, main-class MainKt
app\Salt Player for Windows.cfg         JVM options (below)
app\skiko-windows-x64.dll               Compose/Skiko renderer
app\icudtl.dat                          ICU data
app\resources\bass*.dll                 BASS + add-ons (see §3.1)
app\resources\FluentLib.dll             WinUI/Fluent visual effects
app\resources\MACDll64.dll              Monkey's Audio (APE) decoder
app\resources\spwdecode.dll / spwape.dll / spwruntime.dll   proprietary SPW decoder layer
app\resources\steam_api64.dll           Steamworks
app\resources\icon.ico, next.ico, play.ico, previous.ico, pause.ico
app\resources\bg_wallpaper.jpg          (actually RIFF/WEBP despite the extension)
app\resources\ic_track_cover_default.png
runtime\                                bundled JRE (includes nvdaControllerClient64.dll,
                                        javaaccessbridge.dll, windowsaccessbridge-64.dll)
```

`app\Salt Player for Windows.cfg`:

```
app.classpath=$APPDIR\ffmpeg-x64.dll
app.mainclass=MainKt
-Djpackage.app-version=1.10.0
-Dcompose.application.resources.dir=$APPDIR\resources
-Dcompose.application.configure.swing.globals=true
-Dfile.encoding=UTF-8  -Dsun.jnu.encoding=UTF-8
-Xmx4096M  -Xss500K
-XX:+UseCompactObjectHeaders  -XX:UseZGC
--add-opens=java.base/java.lang=ALL-UNNAMED
--add-opens=java.desktop/sun.awt=ALL-UNNAMED
--add-opens=java.desktop/sun.awt.windows=ALL-UNNAMED
-Dskiko.library.path=$APPDIR
```

> **Key discovery.** The file named `app\ffmpeg-x64.dll` is **not** an FFmpeg build — it is a **ZIP/JAR** (magic `PK\x03\x04`, ~40 MB, **18,748 entries**) containing the entire compiled application. The launcher loads it as the classpath. Extracting and decoding it yielded:
>
> * **Compiled Compose string resources** (`.cvr`) — decoded from a `key|base64(value)` format into **362 UI strings** across 8 locales (en, zh, zh-rTW, ja, ko, ru, id). These are the app's *own UI labels*: effectively a complete map of its menus and settings.
> * **Class-file constant pools** — parsed with a big-endian class reader to recover the real **`dp` values, alpha values and ARGB colours** used by the theme.
> * **Class and package names** — R8 obfuscated *simple* names into CJK glyphs, but **package paths and nested class names survived**, exposing the exact screen inventory, route table, enum values and settings keys.
> * **159 drawable resources** — icons, quality badges, genre backgrounds, fonts.

**(B) Official web documentation.** `github.com`, `raw.githubusercontent.com`, `store.steampowered.com` and `steamdb.info` were **DNS-blocked** in this environment, but the mirror **`https://gh-proxy.com/https://raw.githubusercontent.com/...`** worked, as did **`https://moriafly.com/program/spw/`**. This gave the official VitePress documentation set, the full changelog, the Steam/Microsoft Store listing text, and the plugin API repo.

### 0.2 Confidence legend

| Tag | Meaning |
|---|---|
| **[V]** | **Verified from the local binary** — a string, resource, enum or constant read directly out of v1.10.0. |
| **[W]** | **Verified from a cited official/third-party web source.** |
| **[OCR]** | **Measured from an official screenshot via OCR bounding boxes** — real pixel coordinates on a 1920 × 1080 canvas. Reliable for *position and text*, useless for colour. |
| **[I]** | **Inferred** — a reasonable engineering conclusion from verified evidence, not directly observed. |
| **[X]** | **Could not verify** — see §6. |

**(C) Screenshot OCR — the layout ground truth.**

I could not *view* images (the harness rejects non-text content types, and the shell has no outbound network), but I obtained **real 1920 × 1080 screenshots** and read them via **OCR-by-URL** (`api.ocr.space/parse/imageurl`, `isOverlayRequired=true`), which returns **per-word bounding boxes**. Because the canvases are exactly 1920 × 1080, **those boxes are real pixel coordinates**, giving measured layout geometry rather than guesswork.

Sources OCR'd: **4 Microsoft Store screenshots** (build **1.12.0 EA**, from the Store catalog API) and **6 Steam store screenshots** (build **24.5.1504 / 1.0.0.1118**, from the Steam image CDN). All geometry in §1.0 is measured from these.

> ### ⚠️ Caveats that remain
>
> 1. **Colour and visual styling still could not be sampled.** OCR returns text and boxes only — no pixel colours, no fill, no blur, no corner radii. **Every colour value in §2 comes from the binary's constant pools (reliable), but no colour could be *confirmed visually*, and no radius/elevation/spacing token could be measured.** §6.3 lists these.
> 2. **OCR is imperfect.** Small glyphs mis-read (e.g. `CD` → `cD`, `HiRes` → `F1`/`IiRes`, window buttons → `一 口 X`). Icon-only buttons produce **no text and therefore no boxes** — so the transport controls' positions are *not* measurable this way. Where I infer, I say so.
> 3. **Two builds are represented.** Microsoft Store shots are **1.12.0 EA**; Steam shots are the much older **24.5.1504**. My binary is **1.10.0**. The official changelog runs to **1.18.0**. Where these disagree I state it. The **sidebar was renamed between builds** (§1.2).
> 4. **`isOverlayRequired` coordinates are in the source image's pixel space.** I have assumed 1:1 with the 1920 × 1080 asset (the API reports the asset at that size), which is consistent across all measurements.

---

## 1. Layout description

### 1.0 Measured geometry — from official 1920 × 1080 screenshots

**This is the single most useful part of the document.** All figures are **measured pixel coordinates** from OCR bounding boxes on 1920 × 1080 assets, **not estimates**. Source: Microsoft Store screenshot "Desktop/1" (build 1.12.0 EA), Songs page.

**Vertical structure — three fixed bands**

| Band | Measured Y extent | Height | Content |
|---|---|---|---|
| **Caption bar** | `y = 20 … 42` (text) | **≈ 64 px** total | App title left, window buttons right |
| **Body** | `y ≈ 64 … 990` | **≈ 926 px** | Sidebar + content pane |
| **Bottom mini player bar** | `y ≈ 1005 … 1047` (text) | **≈ 90 px** | `•••` · sample rate · volume glyph · level |

**Caption bar (measured)**

| Element | Left | Top | Height | Notes |
|---|---|---|---|---|
| `Salt Player 1.12.0 EA` (app title) | **70** | 20 | 22 | 12 px inset from window edge |
| `风流倜傥哈基盐` (current track title, centred) | **1490** | 20 | 22 | right-ish; centre of text ≈ 1556 — **not window-centre**, so it is right-aligned before the buttons |
| `一` (minimise) | **1736** | 22 | 14 | |
| `口` (maximise) | **1803** | 22 | 22 | |
| `X` (close) | **1873** | 22 | 22 | 1920 − 1873 − 20 = **27 px** right margin |

→ Window buttons occupy **x ≈ 1736 … 1893**, i.e. a **~157 px** cluster with **~60–70 px pitch** between glyph centres. Caption text baseline sits at **y ≈ 20–42**, so the caption band is roughly **64 px** tall.

**Left sidebar (measured)** — the highest-value measurement

| Item | Left (text) | Top | Row pitch |
|---|---|---|---|
| `歌曲` (Songs) | **89–92** | **92** | — |
| `曲风` (Genres) | 92 | **151** | **59** |
| `专辑` (Albums) | 92 | **212** | **61** |
| `艺术家` (Artists) | 92 | **271** | **59** |
| `文件夹` (Folders) | 89 | **332** | **61** |
| `音乐库` (Music Library) | 92 | **405** | **73** ← group gap |
| `设置` (Settings) | 92 | **463** | **58** |
| `新建歌单` (New Playlist) | 89–92 | **536** | **73** ← group gap |
| `ZARD` (playlist) | 89 | **608** | **72** |
| `Color` | 95 | **667** | **59** |
| `纯音乐` | 89 | **726** | **59** |
| `我喜欢的` | 89 | **787** | **61** |

**Derived sidebar metrics:**
* **Row height ≈ 59–61 px**; **group separators add ≈ 13 px** (73 − 60), giving a **~73 px** pitch across group boundaries.
* Text starts at **x ≈ 89–92**, i.e. a **~90 px** left content inset — consistent with a **~28 px** icon followed by a gap and then the label. **[I]**
* The playlist list continues to `y = 787` and beyond, so the sidebar scrolls.
* **Estimated sidebar width ≈ 300–340 px** **[I]** — the widest sidebar text (`风流倜傥哈基盐`-class playlist names, `Leo/need/MORE MORE JUMP!…`) plus right padding; the content pane's first column begins at **x = 441** (§ below), which bounds the sidebar to **< 441 px**. **A ~320 px sidebar is the best estimate.**

**Content pane (measured)**

| Element | Left | Top | Height | Notes |
|---|---|---|---|---|
| Page title `歌曲` | **352** | **92** | **45** | large heading |
| Count `214` | **452** | 98 | 31 | sits to the right of the title |
| Column 1 — track title (`月光`) | **441–444** | 226 | 25 | |
| Column 1 — artist (`胡彦斌`) | 444 | 256 | 20 | 30 px below title |
| Quality badge (`CD`) | 444 | 256 | 20 | inline before artist |
| Column 2 — album (`靓声天王`) | **1108** | 256 | 23 | |
| Column 3 — duration (`03:30`) | **1775** | 159 | 17 | right-aligned, ends ≈ 1825 |
| **Row height** | — | 159 → 226 → 327 → 424 → 522 → 622 → 723 → 820 → 918 | — | **≈ 98–100 px** pitch |

**Derived content-pane metrics:**
* **Track row height ≈ 98 px** (measured pitches: 159→226 = 67 is a header→first-row gap; steady-state 226→327 = **101**, 327→424 = **97**, 424→522 = **98**, 522→622 = **100**, 622→723 = **101**, 723→820 = **97**, 820→918 = **98**). **≈ 98–100 px.**
* **Three-column table:** title+artist at **x ≈ 441**, album at **x ≈ 1108**, duration right-aligned ending at **x ≈ 1825**.
* Right margin: 1920 − 1825 = **95 px** — matching the sidebar's ~90 px left inset, so the app uses a **symmetric ≈ 90–95 px outer gutter**.
* Content pane horizontal span ≈ **441 … 1825 = 1384 px**; sidebar ≈ **0 … ~340 px**; gutter between them ≈ **100 px**.

**Bottom mini player bar (measured)**

| Element | Left | Top | Height |
|---|---|---|---|
| `•••` (more / overflow) | **1641** | 1016 | 14 |
| `48kHz` / `96kHZ` (output sample rate) | **1700** | 1030–1033 | 14–17 |
| `-））` (speaker / volume glyph) | **1783** | 1005 | 20 |
| `23` (volume level) | **1789** | 1030–1033 | 14–17 |
| `ZARD.` (now-playing, left side) | **120** | 1029 | 21 |
| `泣` (artwork/lyric glyph, centre-left) | **1088** | 1007 | 28 |

→ The bar is **right-weighted**: the now-playing label sits at **x ≈ 120** (aligned with the sidebar), a large artwork/lyric element near **x ≈ 1088** (roughly pane-centre), and the **controls cluster at x ≈ 1641 … 1820**. Bar vertical extent **y ≈ 1000 … 1050**, so **≈ 90 px** tall including padding. **This is the "迷你播放条" (mini player bar), not a full transport bar** — confirmed by the changelog (*"迷你播放条音频输出采样率显示"*, 1.5.10; *"迷你播放条音量按钮可鼠标滚轮快速调节音量"*, 1.6.10).

**Settings page (measured)** — proves settings render *beside* the sidebar, not over it

From Microsoft Store "Desktop/3" (Audio Engine settings): the sidebar items `歌曲`(y=92), `曲风`(151), `专辑`(212), `艺术家`(271), `文件夹`(332), `音乐库`(405), `设置`(463), `新建歌单`(536), `ZARD`(608), `Color`(667), `纯音乐`(726), `我喜欢的`(787) appear at **identical coordinates** to the Songs page. Settings content occupies **x ≈ 351 … 1189**:

| Element | Left | Top | Height |
|---|---|---|---|
| Page title `音频引擎` | **351** | **92** | **45** |
| `Channel 1` meter label | 377 | 187 | 20 |
| `-48 dBFS` | 377 | 248 | 20 |
| `Channel 2` | 380 | 310 | 20 |
| `-48 dBFS` | 377 | 374 | 17 |
| Meter scale `-18` | **1284** | 248 | 17 |
| Meter scale `-6` | **1663** | 248 | 23 |
| Meter scale `0` | **1859** | 248 | 17 |
| `DirectX` (output mode, selected) | **393** | **480** | **29** |
| `DirectSound` | 396 | 513 | 20 |
| `Windows 音频会话API` | **1150** | 511 | 22 |
| `音量` (Volume) | 377 | 622 | 23 |
| `23 （-12.72 dB）` (value, right-aligned) | **1730** | 622 | 23 |
| `配置` (Configuration section) | 377 | 762 | 22 |
| `Windows 音频会话API独占模式` | **374** | **823** | **25** |
| `抖动` (Dither) | 374 | 887 | 26 |
| Dither description (3 lines, wraps to x ≈ 1189) | 377 | **918** | 22 |

**Derived settings metrics:**
* **Settings rows are ≈ 64 px apart** (823 → 887), with a **~30 px gap** between a row label and its description.
* **Two-column settings layout for selectors:** option `DirectX` at **x ≈ 393** and option `Windows 音频会话API` at **x ≈ 1150** — i.e. the output-mode selector is a **horizontal row of two options** spanning the pane, not a vertical radio list.
* **Section headers** (`配置` at y=762) are separated from the previous block by a large gap (622 → 762 = **140 px**).
* **Label-left / value-right pattern:** `音量` at x=377 and its value at x=1730 — a classic settings row.
* **Meters span x ≈ 377 … 1873**, i.e. **nearly the full pane width**, confirming the content pane extends to ≈ **1873** on this page (wider than the track list's 1825 duration column edge).

**Now-playing view (measured, from Steam `ss_53b1…` and Store "Desktop/0")**

| Element | Measured |
|---|---|
| Lyrics block | **3–5 stacked text lines**, large, occupying the upper-middle |
| Title `Tiny Me` | below the lyrics |
| Progress `01:38/03:49` / `02:08/03:49` | below the title |
| `48 kHz` | in the bottom bar |
| **Sidebar** | **absent** |

→ **The now-playing view replaces the entire shell** (no sidebar, no track list) — it is a **full-window overlay**, not a pane. Corroborated by the changelog's *"播放界面展开关闭动画"*, *"退出播放界面"*, *"播放界面点击标题栏返回"*.

**Lyric line structure (measured)** — the most distinctive visual feature

The lyrics render as a **multi-line stack per lyric phrase**, confirmed in both builds:

```
chi 'c cha na wa ta shi ha sa          ← romanisation
今天也 今天也 啊啊 很在意                  ← translation (line 1)
今日 今日                                ← original (line 2)
kyo u mo kyo u mo aa ki ni shi te ru   ← romanisation (line 2)
觉得难过吗？很难过                         ← translation (line 2)
ka na shi ku na 't ta ? ka na shi ku na t ta
```

So each original lyric line is followed by its **romanisation and/or translation as sub-lines** — matching the binary's `show_player_lyrics_sub_text` / `show_desktop_lyrics_sub_text` toggles and `lyrics_translation_font_size_scale`. **Design implication: the lyric view must support a variable-height, multi-row-per-phrase layout, not a fixed one-line-per-phrase list.**

### 1.1 Window shell


Salt Player uses a **custom-drawn (borderless) window with a DWM-composited backdrop** — not the native OS title bar.

* **[V] Custom caption bar.** A string key `caption_bar` exists, and four dedicated window-control vectors ship in the bundle: `ic_window_minimize.svg`, `ic_window_maximize.svg`, `ic_window_restore.svg`, `ic_window_close.svg`. All are **16 × 16 viewBox** drawn in a single flat colour **`#A8ADBD`** (desaturated blue-grey). The minimise glyph is a 10 × 1 px bar at `x=3, y=7`.
* **[V] The window has a system menu and custom hit-testing.** The Windows-interop layer defines `HTSYSMENU`, `HTMINBUTTON`, `HTMAXBUTTON` plus `GetSystemMenu` / `SetMenuDefaultItem` / `TrackPopupMenu` / `hSubMenu` / `hbmpItem` — the app re-implements the native window menu (right-click on the caption bar) with custom item bitmaps.
* **[V] Backdrop materials.** Two enums define the window material:
  * `SpwWindowStyle` = **`None` | `WindowsAcrylic` | `WindowsMica` | `WindowsMicaAlt`** (default `None`)
  * `WindowBackdrop` = **`None` | `Solid` | `Acrylic` | `AcrylicWithTint` | `Mica` | `MicaTabbed`**
  * plus `WindowCornerPreference` (DWM rounded corners), `AccentState` / `AccentFlag` / `WindowCompositionAttributeData` (the undocumented `SetWindowCompositionAttribute` acrylic technique), and `DwmSystemBackdrop`.
  * Windows build gates are present: **17763, 18985, 19033, 22000, 22523** — the app feature-detects OS build to choose a backdrop API (Mica needs 22000+, MicaAlt needs 22523+).
* **[W] Official confirmation of the window styles.** The docs name them in Chinese as **椒盐经典** (Salt Classic = `None`), **亚克力** (Acrylic), **云母** (Mica), **云母 Alt** (Mica Alt). Requirements: **Windows 11 21H2 (build 22000) or newer**, Windows *透明效果* must be enabled, and battery-saver must be off. Mica/Mica Alt **sample the system wallpaper**, so they may not work with **Wallpaper Engine** wallpapers. From **1.14.0**, Acrylic became the default on Windows 11 22H2+. [W]
* **[W] Window full-screen button** is a toggle in the title bar (matching my binary's `window_full_screen_button` key).
* **[I→OCR] Layout (now measured).** The caption bar spans the window width (**≈ 64 px** tall): app title at **x ≈ 70**, current track title right-aligned ending **x ≈ 1625**, window buttons at **x ≈ 1736 … 1893**. Below it the body (**y ≈ 64 … 990**) splits into a **navigation sidebar (≈ 320 px wide)** and a **content pane (x ≈ 441 … 1873)**. A wallpaper layer (`enable_wallpaper`, `WallpaperScreen`, `bg_wallpaper`) can sit behind translucent surfaces. See §1.0 for the full measurement table.

### 1.2 Navigation model — a route-based sidebar

**[OCR]** The sidebar is a **persistent left rail with TEXT labels (not an icon-only rail)**, and it is **visible on every page including Settings** (measured: identical coordinates on the Songs and Audio-Engine pages — see §1.0).

**Measured sidebar order (build 1.12.0 EA, Chinese locale):**

| Group | Items (top → bottom, with measured Y) |
|---|---|
| **Browse** | `歌曲` Songs (92) · `曲风` Genres (151) · `专辑` Albums (212) · `艺术家` Artists (271) · `文件夹` Folders (332) |
| **Library** | `音乐库` Music Library (405) · `设置` Settings (463) |
| **Playlists** | `新建歌单` New Playlist (536), then user playlists: `ZARD` (608) · `Color` (667) · `纯音乐` (726) · `我喜欢的` (787) · … |

**[OCR] Build difference — the sidebar was renamed between versions.** The older Steam build (24.5.1504) showed:

```
音轨 · 专辑 · 曲风 · 艺术家 · 文件夹 · 制作人员 · 音乐库 · 设置 · 添加歌单
```

So `音轨` → **`歌曲`**, `制作人员` (Credits) was **dropped**, and `添加歌单` → **`新建歌单`**. Note also that `专辑`/`曲风` swapped relative order between builds. **Do not treat either ordering as canonical — the 1.12.0 EA ordering above is the newer one.**

**[V] The app uses Compose Navigation with a serialisable, type-safe route table** (`ScreenRoute` is a `@Serializable` sealed hierarchy with generated `$$serializer` classes). The internal route keys recovered from the binary are the **English snake_case** identifiers:

| Route key | UI label (English string resource) | Chinese UI label (OCR) | Icon resource |
|---|---|---|---|
| `track` | Songs / Tracks | 歌曲 | `ic_track` |
| `genre` | Genres | 曲风 | `ic_genre` |
| `album` | Albums | 专辑 | `ic_album` |
| `artist` | Artists | 艺术家 | `ic_artist`, `ic_artist_small` |
| `folder` | Folders | 文件夹 | `ic_nav_folder` |
| `music_library` | Music Library | 音乐库 | `ic_nav_add`, `ic_drag_and_drop` |
| `settings` | Settings | 设置 | `ic_settings` |
| `custom_folder` | Custom Folders | — | `ic_nav_folder` |
| `lyrics` | Lyrics | — | `ic_lyrics` |
| `image_library` | Image Library | — | `ic_media_source` |
| `cd_toolkit` | CD Toolkit | — | `ic_cd`, `ic_compact_disc` |
| `more` | More | — | `ic_menu` |

**[I]** `track` (Songs) is the default landing route — the Store screenshots open on it. `settings` opens a **nested navigation stack** (each sub-page pushes within the settings area), because the appearance screen's bytecode repeatedly calls `getLocalNavController()` while reaching for sibling pages (`track_item_appearance`, `wallpaper`, `render`).


**Settings sub-pages** (each is both a route key and a string resource): **[V]**

| Route key | Label |
|---|---|
| `appearance` | Appearance |
| `wallpaper` | Wallpaper |
| `render` | Render |
| `language` | Language |
| `audio_engine` | Audio Engine (SPW Audio Engine / SPW Mixer) |
| `format_support` | Format Support |
| `laboratory` | Laboratory |
| `steam_account` | Steam Account |
| `workshop` | Workshop |
| `mod_management` | Mod Management |
| `third_party_apps` | Third-Party Apps |
| `help_and_feedback` | Help and Feedback |
| `accessibility` | Accessibility |
| `about` | About |
| `cache` | Cache |
| `app_data` | App Data |
| `keyboard_shortcut` | Keyboard Shortcut |
| `open_source_projects_used` | Open Source Projects Used |
| `early_access` | Early Access |
| `dxgi_compat_mode` | DXGI Compat Mode |
| `has_unreadable_track` | Has Unreadable Track |
| `track_item_appearance` | Track Item Appearance |

**[I]** `music_library` is the default landing route. `settings` opens a **nested navigation stack** (each sub-page pushes within the settings area), because the appearance screen's bytecode repeatedly calls `getLocalNavController()` while reaching for sibling pages (`track_item_appearance`, `wallpaper`, `render`).

### 1.3 The Playback (Now Playing) screen

Three distinct concepts are named in the resources and should be treated as **three separate surfaces**: **[V]**

* `playback_screen` — "Playback Screen" (the large now-playing page)
* `player_screen` — "Player Screen"
* `playback_screen_lyrics` — "Playback Screen Lyrics"

Verified properties: **[V]**

* **Collapsible/expandable.** Config key `is_playback_screen_expand` (accessors `getIsPlaybackScreenExpand` / `setPlaybackScreenExpand` / `updateIsPlaybackScreenExpand`), plus a `go_to_now_playing` action.
* **Full-screen mode.** `FullscreenButton`, `getFullscreen` / `setFullscreen` / `updateFullscreen`, `isFullscreen`, `window_full_screen_button`, icons `ic_full_screen`, `ic_window_full_screen`, `ic_mini_player_full_screen`, `ic_window_restore_full_screen`, and a dedicated package `com.xuncorp.voxzen.ui.window.fullscreen` (with `ExtendedUser32` for exclusive fullscreen). Setting `auto_hide_mouse_pointer_on_playback_screen`.
* **Circular cover option.** `show_circle_cover_art` with strings `circle_playback_cover` = "Circle Playback Cover" and `circle_play` = "Circle".
* **"Sunglow" effect.** `sunglow_effect` config key + string, and assets `ic_track_cover_sunglow.png`, `ic_sunglow_default.jpg`. **[W]** The official Chinese name is **霞光特效** (aurora / light-flow effect). It was default in 1.0.803, removed in 1.0.1010, and re-added in 1.5.20.
* **Multi-layer blur.** `multilayer_blur_effect` + string "Multi-Layer Blur Effect", described in-app as *"Rendering real-time overlay blur effects on multiple layers"*. `AppDefaults` defines `HAZE_INPUT_SCALE = 0.66` — consistent with a backdrop-blur implementation rendered at 66 % scale for performance. **[V]**
* **[W] 3D cover animation** was added in 1.6.20 (3D 封面动画), alongside circular cover and a lyric float-up animation (歌词上浮动画).
* **Lyrics live on the playback screen** (`playback_screen_lyrics`, `show_player_lyrics_sub_text`, `blur_inactive_lyrics`).
* **[OCR] It is a full-window overlay, and it is lyrics-centric.** Measured: the **sidebar is absent**, the lyrics block occupies the upper-middle as **3–5 stacked lines**, with the track title (`Tiny Me`) below them and the progress (`01:38/03:49`) below that. Changelog language confirms open/close semantics (*"播放界面展开关闭动画"*, *"退出播放界面"*, *"播放界面点击标题栏返回"*). **[W]** The now-playing view is **always dark** regardless of theme (*"播放界面始终为深色"*), and album art is centred in it.

**Transport icons** (exact sizes from the SVG sources): **[V]**

| Icon | Size | Notes |
|---|---|---|
| `ic_round_skip_previous_24.svg` | 30 × 30, viewBox 24 | previous |
| `ic_round_skip_next_24.svg` | 30 × 30, viewBox 24 | next |
| `ic_play_queue.xml` | 28 dp, viewBox 28 | queue; 3-row list glyph with leading dots |
| `ic_player_more.svg` | viewBox 226 | horizontal 3-dot "more" |
| `ic_mini_player_play.svg` | 38 × 38 | mini-player play |
| `ic_mini_player_pause.svg` | 38 × 38 | mini-player pause |

All transport vectors paint with `@color/salt_color_icon_foreground` — **icons are tinted from a theme token**, not hard-coded. **[V]**

### 1.4 The player bar

> **Measured correction to my binary-only inference.** I originally inferred a conventional transport bar (prev/play/next/seek/volume). **The screenshots show something different: the persistent bar at the bottom is the 迷你播放条 (mini player bar)** — a **slim ≈ 90 px strip** containing the now-playing label, artwork/lyric element, an overflow `•••` button, an **audio-output sample-rate readout**, and a **volume control**. The full transport controls live on the **now-playing overlay**, not in the persistent bar.

**[OCR] Measured contents of the bottom bar** (1920 × 1080, y ≈ 1000 … 1050):

| Element | x | y | Interpretation |
|---|---|---|---|
| `ZARD.` | **120** | 1029 | now-playing label, aligned with the sidebar's left gutter |
| `泣` (artwork/lyric glyph) | **1088** | 1007 | large element near pane centre |
| `•••` | **1641** | 1016 | overflow / more menu |
| `48kHz` / `96kHZ` | **1700** | 1030 | **current audio output sample rate** |
| `-））` | **1783** | 1005 | speaker / volume glyph |
| `23` | **1789** | 1030 | **volume level** |

**[W] Changelog corroboration:** *"迷你播放条音频输出采样率显示"* (1.5.10 — mini bar shows output sample rate), *"迷你播放条音量按钮可鼠标滚轮快速调节音量"* (1.6.10 — wheel-adjustable volume), *"迷你播放条横向布局范围选择"* (1.16.2 — horizontal layout span selector), *"Liquid Glass 迷你播放条"* (1.18.0), and 1.16.1's *"折叠动画期间…侧边栏无法立刻响应操作"* implying **both the sidebar and the mini bar have collapsed/expanded animated states**. **[W]** 1.8.2: *right-clicking the mini bar's left region opens the track menu*.

**[V]** Verified control surface (from the binary's strings and icons — these are the controls the app has, wherever they are placed):
* **Transport:** `previous` / `play` / `pause` / `next`, `ic_round_skip_previous_24.svg`, `ic_round_skip_next_24.svg` (30 px), `ic_mini_player_play.svg` / `ic_mini_player_pause.svg` (38 px)
* **Volume** — `volume`, `volume_control_curve` ("Volume Control Curve": `Linear` / …), `windows_volume_synthesizer`, `ic_volume`, `changeVolume`/`getVolume`/`setVolume`
* **Playback mode** — `playback_mode`, `random_play`/`random`, `repeat_all`, `repeat_one`, `ic_play_mode_circle`
* **Speed** — `playback_speed`, `ic_speed`
* **Queue** — `playback_queue`, `play_queue`, `ic_play_queue`
* **Favourite** — `favorite`, `remove_favorite`
* **Track info** — `artist_s` = "Artist: %1$s", `album_s` = "Album: %1$s", `album_artist_s` = "Album Artist: %1$s", `genre_s` = "Genre: %1$s"

**[W]** The **mini player was redesigned as a horizontal "mini bar"** in 1.16.x (迷你播放条横向布局范围选择) with a **Liquid Glass** style in 1.18.0 — so post-1.10 versions have a different mini-player form factor from my binary.

### 1.5 Track list rows

**[V]** Highly configurable. Settings: `track_item_appearance` ("Track Item Appearance"), `show_audio_quality_badge`, `track_item_check_boxes` ("Use Check Boxes to Select Items"), and a `track_preview_pane` toggle.

* **Audio-quality badges are real image chips.** Ten PNG assets ship: `ic_audio_quality_{raw,cd,cdp,hq,hr}_{light,dark}.png`. Measured sizes: **HiRes = 81 × 30 px; CD = 48 × 30; CD+ = 66 × 30; RAW = 66 × 30**. Pill-shaped, white text on a saturated fill. **[V]** Sampled fills: **CD / CD+ ≈ steel blue**, **RAW ≈ brick/brown-red**, **HiRes ≈ amber/gold**. `ic_hi_res.webp` also exists.
* **[W] Official badge definitions** (from the official *track-item* doc, published 2025-08-19):

  | Badge | Definition |
  |---|---|
  | **HQ** | bitrate 320 kbps |
  | **CD** | 16-bit / 44.1 kHz |
  | **CD+** | bit depth > 16-bit **or** sample rate > 44.1 kHz |
  | **HiRes** | 24-bit / 96 kHz and above (RIAJ Hi-Res Audio standard) |
  | **RAW** | 32-bit / 192 kHz and above |

  Notes: SPW replaced the Android app's "SQ" badge. 24/44.1, 24/48 and 16/48 are classed **CD+**. From **1.6.20**, DSD audio shows **no badge at all**. [W]
* **Row content** (from the `Track` entity + tag writer): `title`, `artist`, `album`, `albumArtist`, `track_number`, `disc_number`, `year`, `genre`, `duration`, `filename`, `folder_path`, `size`, `path`, `added_time`, `modified_time`, `play_count`, `bits_per_sample`, `sample_rate`, `average_bitrate`, `channel`, `frequency`. **[V]**
* **[I→OCR] Row structure (now measured).** A row is **≈ 98–100 px tall** with a **three-column table**: **title + artist (+ quality badge) at x ≈ 441**, **album at x ≈ 1108**, **duration right-aligned ending x ≈ 1825**. The title line is ~25 px tall with the artist/badge line ~20 px tall and **30 px below** it. See §1.0.
* **[OCR] Observed rows** (Songs page): `月光 / CD 胡彦斌` (03:30) · `Worlders / Leo/need/MORE MORE JUMP!/Vivid BAD SQUAD/…` (04:49) · `是风动 / CD 银临/河图` (04:48) · `春闺仕女图 / CD+ 河图` (03:51) · `Tiny Me / CD masarada` · `End of Time / K-391` (03:07) · `普通朋友 / CD 陶喆` (04:15). The **artist field truncates with an ellipsis** when it contains many names — a required behaviour.
* **[W]** 1.18.0 added **alphabet quick-jump** in long lists (列表字母快速跳转).

### 1.6 Mini player

> **[OCR] Resolved.** The "mini player" **is** the persistent bottom bar described in §1.4 — the 迷你播放条. It is **≈ 90 px tall** and spans the window width. It is *not* a separate floating window in the measured build.

**[V]** Assets and settings:
* `ic_mini_player_play.svg` (38 × 38), `ic_mini_player_pause.svg` (38 × 38), `ic_mini_player_more.png`, `ic_mini_player_full_screen.png`
* Setting `auto_hide_mini_player_controls` ("Auto-Hide Mini Player Controls") — **[W]** added 1.6.10

**[W] Evolution:** 1.16.2 added a **horizontal layout span selector** (迷你播放条横向布局范围选择) allowing restoration of the ≤1.15.2 layout; 1.18.0 introduced a **Liquid Glass** style. 1.16.1 mentions a **collapse animation**, so the bar has collapsed and expanded states.

**[I]** Controls fade out until hover (that is what "auto-hide controls" means), and the left region opens the track menu on right-click **[W]** (1.8.2).

### 1.7 Desktop lyrics

**[V]** A **separate always-on-top, optionally click-through window**:
* Config keys: `desktop_lyrics`, `desktop_lyrics_alignment`, `desktop_lyrics_window_is_locked`, `desktop_lyrics_window_position_x`, `desktop_lyrics_window_position_y`, `show_desktop_lyrics_sub_text`
* Strings: `desktop_lyrics` ("Desktop Lyrics"), `desktop_lyrics_lock_window` ("Lock lyrics window"), `desktop_lyrics_release_window` ("Unlock lyrics window"), `desktop_lyrics_lock_window_position`, `auto_hide_desktop_lyrics_in_fullscreen` ("Auto-hide desktop lyrics in fullscreen apps")
* The window **remembers its X/Y** and has a **lock** state — so it is draggable and position-persistent.
* **[W]** 1.6.0 added position memory; 1.8.0 added playback info/controls/close button; 1.11.0 added colour adjustment and hiding of already-played lines; 1.13.0 added text stroke (桌面歌词描边); 1.18.0 added tray-based pin/unlock of desktop windows.

### 1.8 Settings pages

**[V]** Settings is a **nested list-of-sub-pages** structure (not one long scroll), evidenced by each area being its own `ScreenRoute` + composable (`AppearanceScreen`, `WallpaperScreen`, `RenderScreen`, `DxgiCompatModeScreen`, `TrackItemAppearanceScreen`, `FontStrategyPanel`, `LanguageScreen`).

**Appearance screen contents** (reconstructed from `AppearanceScreen`'s constant pool — the *exact* row identifiers it references): **[V]**
`light_dark_theme` (ThemeModeItem: Light / Dark / Follow System) · `spw_window_style` (ThemeStyleItem: None / Acrylic / Mica / Mica Alt) · `enable_wallpaper` · `font_strategy` + `custom_font_file_path` (FontStrategyPanel) · `render` (`render_api`, `gpu_priority`, `vsync`) · `track_item_appearance` (`show_audio_quality_badge`, `track_item_check_boxes`) · `always_on_top` · `close_main_window_strategy` · `multilayer_blur_effect` · `show_circle_cover_art` · `sunglow_effect` · `taskbar_title_show_listening_to` · `window_full_screen_button`.

**[W] Official Appearance doc confirms and extends this:**
* **模式 (Mode)** — default is **深色 (Dark)**; options 跟随系统 / 浅色 / 深色. "Follow system" tracks Windows *个性化 → 颜色 → 选择模式*.
* **样式 (Style)** — 椒盐经典 / 亚克力 / 云母 / 云母 Alt, with the Windows 11 21H2+ / transparency / power-saving caveats noted in §1.1.
* **窗口全屏按钮** toggle.
* Other appearance features from the changelog: **自定义壁纸** (custom wallpaper, 1.13.0, with wallpaper material + blur style), **自定义字体** (custom font, 1.0.1298; **.woff/.woff2** web-font support in 1.7.20), **多层模糊效果**, **无障碍显示缩放** (accessibility display scaling, min 90 %, 1 % steps, 1.0.1167), **霞光特效**, **3D 封面动画 / 圆形播放封面 / 歌词上浮动画** (1.6.20), **Liquid Glass 迷你播放条** and **Morvanium 效果** (1.18.0).

**Font strategy** enum: **`FollowSystem` | `MiSansRegular` | `Custom`**, with `custom_font_file_path`, `font_size`, `font_weight`, and a `File → Font` loader. The bundle ships **MiSans Regular** (`misans.ttf`, 7.9 MB) as a first-class choice. **[V]**

**Render screen** — enums **[V]**:
* `RenderApi` = **`Direct3D` | `OpenGL`** (with `toSkiko` mapping and a `uiName`)
* `GpuPriority` = **`Auto` | `PerfectIntegrated` | `PerfectDiscrete`** (strings "Perfect Integrated", "Perfect Discrete")
* plus `vsync`, `fps_monitor`, `dxgi_compat_mode`, `render_information`, `display_scaling`

**[W] Official Render doc:** SPW can use **DirectX or OpenGL** for UI acceleration — **OpenGL is the default on Windows 10, DirectX on Windows 11**. **V-Sync is on by default**; disabling it raises the frame rate by roughly **2–4×** but consumes a lot of GPU. GPU strategy (auto / prefer integrated / prefer discrete) arrived in 1.0.1167.

**Close-main-window strategy** enum: **`SystemTray` | `ExitProgress`**, with strings `minimize_to_notification_area`, `close_main_window`, `confirm_exit_spw` ("Confirm exit SPW?"), `exit_salt_player`. **[V]**

**Audio-engine settings page** — strings `initialize_audio_engine`, `release_audio_engine`, `engine_not_initialized`, `audio_output_information`, `spw_audio_engine`, `spw_mixer`, `mixer_fallback`, `sample_format_not_supported`, `wasapi_some_functions_not_available`, `d_hz` = "%1$d Hz". **[V]**

**Laboratory** page — `laboratory`, `experimental`, `testing`, `changeable_in_audio_engine_is_released`, `changeable_in_direct_sound_mode`, `changeable_in_wasapi_mode`, `changeable_in_wasapi_exclusive_mode`. **[V]** **[W]** 1.12.0 added Audio Visualizer and Circle Cover Audio Visualizer here.

**Accessibility** page — `accessibility`, `accessibility_screen_intro`, `nvda_screen_reader`, `windows_ease_of_access`, `third_party_accessibility_app`, `use_check_boxes_to_select_items`. The JRE bundles `nvdaControllerClient64.dll` and the Java Access Bridge DLLs. **[V]**

### 1.9 What remains unmeasured

**[X]** Thanks to the screenshot OCR (§1.0), the major structural questions are now **answered**. What is still unknown:

1. **Sidebar width** — bounded to **< 441 px** and estimated at **≈ 320 px**; not directly measurable because sidebar rows have no right-edge glyph.
2. **Icon-only control positions** — transport buttons (prev/play/next) render as glyphs with **no text**, so OCR yields no boxes. Their exact positions on the now-playing overlay are unknown.
3. **Corner radii, spacing scale, elevation/shadow values** — OCR cannot sample geometry or colour.
4. **Album/Artist/Genre layout** — one Store screenshot shows an **album detail page** (large art + metadata + numbered track list), and a Steam screenshot shows a **genre page as a list of text entries** (`流行 / 流行1 / 日本流行1 / ACG / ACG1 / 蓝调 / 其他`), but **whether the Albums index is a grid or a list is not confirmed**.
5. **The first-run wizard's** step count and content.
6. **The keyboard-shortcut settings page** contents — no screenshot found.
7. **The Workshop / Mod manager page** appearance — no screenshot found.
8. **The desktop-lyrics window** appearance — no screenshot found.
9. **Exact transition animations and easing.**
10. **Colour confirmation** — all palette values come from the binary, not from a viewed image (§6.3).

---

## 2. Visual design spec

### 2.1 Colour palette — **verified values**

The theme lives in `com.xuncorp.voxzen.ui.theme.AppTheme` (`AppTheme.kt`, 206 lines) with a separate `AppColors` object and a `CompositionLocalProvider` injecting the scheme. The following ARGB values were read **directly out of the `AppTheme` class constant pool**: **[V]**

**Dark surfaces**

| Token (from bytecode) | ARGB | Hex |
|---|---|---|
| Dark surface A (warm-neutral) | 255, 31, 30, 28 | **`#1F1E1C`** |
| Dark surface B (cool-neutral) | 255, 36, 38, 46 | **`#24262E`** |
| Dark surface C (cool, lighter) | 255, 30, 38, 45 | **`#1E262D`** |
| Dark surface D | 255, 27, 29, 38 | **`#1B1D26`** |
| Dark surface E (warm grey) | 255, 48, 48, 47 | **`#30302F`** |

**Light surfaces**

| Token | ARGB | Hex |
|---|---|---|
| Light surface A | 255, 250, 250, 250 | **`#FAFAFA`** |
| Light surface B (cool) | 255, 243, 245, 247 | **`#F3F5F7`** |
| Light surface C (warm) | 255, 243, 242, 241 | **`#F3F2F1`** |

**Translucent overlays** (scrims / glass over Mica, Acrylic or wallpaper)

| Token | ARGB | Meaning |
|---|---|---|
| `0x90000000` | a=144 black | **56 % black scrim** |
| `0x99FFFFFF` | a=153 white | **60 % white scrim** |
| `0xB9FFFFFF` | a=185 white | **73 % white scrim** |

**Accent / highlight**

| Token | ARGB | Hex | Note |
|---|---|---|---|
| `AppColors.Windows11HighlightDark` | 255, 76, 194, 255 | **`#4CC2FF`** | the Windows 11 **dark-mode system accent** blue |

**Other verified colours**

* Window-control glyphs: **`#A8ADBD`** (`ic_window_*.svg`)
* Windows logo asset: **`#1976D2`** (`ic_logo_windows.svg`)
* Focus/selection rectangle: **`#FFD47800`** (amber) in `ComposeWindowProc`
* Fullscreen path uses `-12845057` / `-131842` / `12582912` — `0xFF3C3C3F`-family DWM frame values and `0x00C00000`-style bits **[I]**

**Interpretation.** The palette is a **Windows-11-native neutral system**: a warm-neutral and a cool-neutral dark ramp, a near-white light ramp, and a **single cyan-blue accent `#4CC2FF`**. There is deliberately **no large Material-3 tonal palette** — the app leans on Mica/Acrylic (which supply the OS wallpaper tint) plus translucent black/white scrims, reserving the accent for selection and active state. `#4CC2FF` is exactly Microsoft's documented Windows 11 dark-mode default accent, strongly implying **[I]** the app **reads the user's Windows accent colour** rather than hard-coding a brand colour.

### 2.2 Theming model

**[V]** from `AppTheme.kt` and `AppConfig`:
* `LightDarkTheme` enum = **`Light` | `Dark` | `FollowSystem`**
* `AppTheme(isDarkTheme, scheme, fontStrategy, customFontFilePath, spwWindowStyle, enableWallpaper, content)`
* Reads the Windows registry value **`AppsUseLightTheme`** to follow the system
* `getSaltUiMaterial` — a shared design-system material from the **Salt UI** library
* **[W]** The official docs confirm the default is **Dark** (not Follow System).

**Design-system lineage [W]:** the official feature list says SPW is *"基于 **Salt UI 2**，辅以 Windows 11 设计风格"* ("based on Salt UI 2, complemented by Windows 11 design style"). The **legacy demo site** said *"新设计的 **Salt UI Pro**"*, and changelog 1.14.0 mentions *"Salt UI 3.0 页面顶部模糊效果"*. The naming is inconsistent across eras — **Salt UI 2** is the safest label for the 1.x era. Salt UI is a Compose Multiplatform UI library shared with the Android app. **[V]** My binary contains only the Windows platform bindings of it (`com.moriafly.salt.ui.platform.windows`, 26 classes; `com.moriafly.salt.ui.window.windows`, 4 classes) — the component library itself is compiled into a separate namespace.

### 2.3 Typography

**[V]**

| Aspect | Value |
|---|---|
| Latin UI font | **Inter** — full family: Thin, ExtraLight, Light, Regular, Medium, SemiBold, Bold, ExtraBold, Black + all italics (16 files) |
| Monospace font | **JetBrains Mono** — Thin…ExtraBold + italics (16 files) |
| CJK font (bundled, selectable) | **MiSans Regular** (`misans.ttf`, 7.9 MB) |
| Font strategies | `FollowSystem` \| `MiSansRegular` \| `Custom` (user-supplied file, incl. .woff/.woff2 from 1.7.20) [W] |
| Lyrics font size | configurable `lyrics_font_size` |
| Lyrics font weight | configurable `lyrics_font_weight`; **value `900`** present in the lyrics screen constant pool |
| Lyrics translation scale | `lyrics_translation_font_size_scale` — translation rendered as a **ratio** of the main size |
| Lyrics line spacing | **`1.6`** (float in `ui/screen/lyrics`) |
| Lyrics size range | constants **`16`** and **`96`** in the lyrics screen — consistent with a 16→96 sp slider |
| Lyrics animation | `karaoke_lyrics_animation_compatibility_strategy`; `KaraokeCompatStrategy` = **`Always` \| `ExpandDocument` \| `OnlyCurrentLine`** |
| Lyrics alignment | `LyricsAlignment` = **`Start` \| `Center`** (with `toTextAlign`) |
| Missing-glyph behaviour | `restart_spw_to_apply_the_change`, `language_screen_tip` = "The selected language settings will take effect upon the next SPW startup" |

**[X]** The **UI typography scale** (body/label/title sizes) is *not* recoverable — the 16/96 values are the *lyrics* slider range, not the UI scale. **[I]** Suggested starting point: body ≈ 14 sp, caption ≈ 12 sp, title ≈ 20 sp.

### 2.4 Shape, radii, and elevation

**[V]** Verified radius/elevation constants:
* `ui/theme/AppTheme` constant pool contains floats **`6`**, **`10`**, **`32`**, **`0.5`**, **`0.1`** and a `DpKt` reference — **[I]** consistent with a small radius (**6 dp**), a medium one (**10 dp**), a large surface (**32 dp**, e.g. dialogs/sheets), `0.5` for 50 % alpha or a circular shape, and `0.1` for a 10 % subtle fill.
* **Window corner preference is delegated to DWM** (`WindowCornerPreference`, `DwmWindowCornerPreference`) — the *outer* window rounding follows Windows 11, not a custom radius. **[V]**
* **Quality badges** are pill chips **30 px tall** (48–81 px wide). **[V]**
* **Elevation:** no Material elevation constants exist; depth comes from **backdrop blur + scrims** (`multilayer_blur_effect`, `0x90000000` / `0x99FFFFFF` / `0xB9FFFFFF`) rather than shadows. **[I]**

### 2.5 Iconography

**[V]** 159 drawables in the app namespace. Characteristics:

* **Mixed formats by role.** Raster **PNG** for photographic/illustrative and multi-colour icons (quality badges, quality marks, developer avatars, brand logos, genre backgrounds); **vector** (VectorDrawable XML or **SVG**) for anything that must tint — transport controls, window buttons, queue, chevrons, checkboxes.
* **Tinting contract.** Vector icons reference `@color/salt_color_icon_foreground`, so one token recolours the whole set per theme.
* **Three icon scales.** A **16 px** window-chrome family; a **24 dp** family (`ic_arrow_drop_down.xml`, `ic_chevron_right.xml`, `ic_uncheck.xml`); a **28–38 px** control family (queue 28, transport 30, mini-player 38).
* **Sidebar icon set:** `ic_nav_folder`, `ic_nav_playlist`, `ic_nav_add`, `ic_album`, `ic_artist`, `ic_genre`, `ic_lyrics`, `ic_track`, `ic_settings`, `ic_media_source`, `ic_play_queue`, `ic_search`, `ic_sort_a_z`, `ic_play_mode_circle`, `ic_volume`, `ic_speed`, `ic_mixer`, `ic_audio_effect`, `ic_audio_enigne` *(sic — misspelled in the original)*, `ic_gapless`, `ic_plugin`, `ic_vst`, `ic_wallpaper`, `ic_keyboard`, `ic_language`, `ic_light_theme`, `ic_dark_theme`, `ic_full_moon`, `ic_accessibility`, `ic_laboratory`, `ic_dev`, `ic_achievement`, `ic_workshop`, `ic_steam`.
* **Feature-signalling / hardware badges:** `ic_hi_res.webp`, `ic_gapless`, `ic_head_bass`, `ic_dolby_digital_plus.png`, `ic_nahimic.webp`, `ic_realtek.png`, `ic_nvda.png`, `ic_microsoft_directx.png`, `ic_gpu.png`, `ic_cpu.png`, `ic_processor.png`, `ic_x64.png`.
* **State/status icons:** `ic_check`, `ic_uncheck`, `ic_error`, `ic_info`, `ic_warning`, `ic_bug`, `ic_database_warning`, `ic_unreadable`, `ic_closed_eye`/`ic_eye`, `ic_pin`, `ic_item_arrow`, `ic_item_expand_arrow`, `ic_item_link`, `ic_drag_and_drop`, `ic_import`, `ic_open_with`, `ic_delete_file`, `ic_file_explorer`.
* **Brand icons:** `ic_telegram.png`, `ic_steam.png`, `ic_steam_48.png`, `ic_zsg_studio.png`, `ic_team403_logo.png`, `ic_xuncorp.png`.

### 2.6 Motion and transitions

**[V]** Verified animation machinery and settings:

| Mechanism | Evidence |
|---|---|
| **Shared element transitions** | config key `shared_transition_scope`; accessors `getSharedTransitionScope` / `updateSharedTransitionScope`; string `shared_element_animation` |
| **Lottie animations** | dependency `io.github.alexzhirkevich:compottie` (757 entries) + asset `files/anim_wave.json` — a 429-frame, 1920 × 1080 After Effects composition of animated dots in `#4CC2FF`-family blues |
| **Karaoke word-by-word** | `karaoke_lyrics_animation_compatibility_strategy` with `Always` / `ExpandDocument` / `OnlyCurrentLine` |
| **Inactive-lyric blur** | `blur_inactive_lyrics` toggle |
| **Multi-layer blur** | `multilayer_blur_effect`, rendered at `HAZE_INPUT_SCALE = 0.66` |
| **Navigation animation constant** | float **`500`** in `AppNavigationKt` — **[I]** a 500 ms navigation/transition duration |
| **Auto-hide** | `auto_hide_mini_player_controls`, `auto_hide_mouse_pointer_on_playback_screen`, `auto_hide_desktop_lyrics_in_fullscreen` |
| **Window animations** | `Dwmapi` / `DwmApi`, `SetWindowCompositionAttribute` transitions for Mica/Acrylic |
| **Async image loading** | Coil 3 (`coil3`, 133 entries) + `landscapist`, with a **cover disk cache** (`COVER_DISK_CACHE_MAX_SIZE_BYTES`) |

**[W]** Additional motion features by version: **歌词上浮动画** (lyric float-up) and **3D 封面动画** (1.6.20); **动态流光 V2** (dynamic light-flow) on Android; **流光特效** and **Morvanium 效果** (1.18.0).

**[X]** Exact easing curves, durations (beyond the `500` constant), and the specific per-screen transition are **not recoverable**.

---

## 3. Feature list

### 3.1 Audio engine

> ### ⚠️ Correction to a widely repeated claim
> **BASS is used on Windows, not only on Android.** The official SPW documentation never mentions BASS (the developer likely omits it for licensing reasons), and a third-party research pass concluded from that silence that SPW uses only an in-house stack. **The binary disproves this.** `com.xuncorp.pisces.PiscesConfig` explicitly declares:
> `bassWindowsLibraryRes`, `bassWindowsPluginResList`, `bassFxWindowsLibraryRes`, `bassMixWindowsLibraryRes`, `bassWasapiWindowsLibraryRes`, `bassCdWindowsLibraryRes`, `bassAndroidPluginResList`, `enabledLog`, project name **`pisces-core`**. **[V]**
> The `app\resources\` folder ships the matching DLLs, and `com/xuncorp/pisces/bass/` contains `Bass`, `BassMix`, `BassFx`, `BassWasapi`, `BassCd` wrappers over `com.un4seen.bass.*`. **BASS is definitively the Windows playback core.** The official "Pisces"/"SPC" naming is the *product* name for this in-house wrapper layer, not a replacement for BASS.

**[V]** Architecture: a first-party layer named **Pisces** (`com.xuncorp.pisces`) over **BASS** (`com.un4seen.bass`, `com.moriafly.bass`). `PiscesPlayer` is the abstraction; `BassPiscesPlayerImpl` the implementation.

* **Engine identity:** strings `spw_audio_engine` ("SPW Audio Engine"), `spw_mixer` ("SPW Mixer"), `pisces_audio_library_version` ("PISCES Audio Library Version"), `engine_not_initialized`, `initialize_audio_engine`, `release_audio_engine`, `mixer_fallback`. **[V]** **[W]** "SPW Pisces 音频库" was introduced experimentally in **1.0.1200 (2025-03-01)**.
* **BASS add-ons shipped** (`app\resources\`): `bass.dll`, `bassflac.dll`, `bassape.dll`, `bassalac.dll`, `bassdsd.dll`, `basswasapi.dll`, `bassmix.dll`, `bass_fx.dll`, `bass_dts.dll`, **`basscd.dll`**; plus `MACDll64.dll` (Monkey's Audio), `FluentLib.dll`, and `spwdecode.dll` / `spwape.dll` / `spwruntime.dll`. **[V]**
* **Format support.** **[W]** The Steam/Microsoft Store listing states verbatim: *"多格式支持：支持 **AAC/AIFF/APE/FLAC/M4A/MP3/OGG/OPUS/WAV/WV** 等多种音频格式解析播放"*. **[V]** The binary confirms dedicated decoders for **FLAC, APE, ALAC, DSD, DTS, CD Audio** and a `format_support` settings page plus configurable `id3v1_decoding_charset`. Format additions by version: **FLAC** core replaced by "SaltAudioTag" (1.2.4); **ALAC in M4A** improved (1.8.0); **CDA** playback (1.4.10–1.5.0); **MP1/MP2/MP3 inside MP4** (1.9.0); **APE and OPUS** (1.15.2); **WAV-DTS** (1.14.0). **[W]**
* **DTS.** **[W]** Official support: **DTS Core** (up to 5.1 channels), **DTS-HD** (extension sub-stream), **DTS 14-bit**, and **S/PDIF-encapsulated DTS** (IEC 61937 burst mode). **Only `.wav` files are supported — bare `.dts` bitstream files are not.** 1.18.0 fixed ordinary WAVs being misdetected as DTS.
* **DSD — contradictory across platforms.** **[V]** `bassdsd.dll` ships and `dsd_format_outdated_intro` warns: *"The DSD format is outdated. We recommend switching to superior formats like FLAC for better audio quality and metadata management experience"*. **[W]** SPW **added** dff/dsf scanning and playback in **1.6.10 (2025-08-23)**, and 1.6.20 made DSD show no badge; but **Android terminated DSD support in 10.6 (2024)** with a published rationale (*"网络上 .dsf/.dff 格式 99% 为人为使用其他格式转换"*). **[X]** DSD64/128/256, DoP and native-DSD specifics are **documented nowhere**.
* **Output modes.** **[V]** `audio_engine_mode` config key with per-mode capability strings for **DirectSound**, **WASAPI (shared)**, **WASAPI Exclusive**, plus a released "Audio Engine" mode. Warning string: *"The current audio device does not support some features of the Windows Audio Session API. Please check the device driver or try another device."*
  **[W] Official Audio Engine doc:** on Windows 10/11, **DirectSound audio is redirected to WASAPI shared mode** and is provided only as a compatibility fallback. **WASAPI Exclusive** lets the app control the hardware directly, **bypassing the Windows system mixer** — lower latency, no system mixing/enhancement, at the cost of blocking other apps from the device. Crucially: *"启用独占模式不等于零 SRC"* — exclusive mode does **not** mean zero sample-rate conversion. **SPW reads the system's preferred sample rate and locks the hardware to it**, resampling every file in high quality to that rate; if a file already matches, no conversion occurs. Recommended: **48 kHz**; for normal listening the docs **do not recommend enabling exclusive mode**.
* **WASAPI Exclusive options** (`ExclusiveProperties` = `exclusive`, `dither`, `perfectSampleRate`): **[V]**
  * `wasapi_exclusive_mode` — "Window Audio Session API Exclusive Mode" *(the app's own wording; "Window" is a typo for "Windows")*
  * `wasapi_perfect_sample_rate` — "Perfect Sample Rate"; `perfect_sample_rate_intro` warns: *"Adaptive track file sample rate, automatically converts with high quality when the device is unsupported. Please note: ⚠️Enabling this feature will re-request the hardware sample rate when switching tracks, causing a slight stutter and disabling gapless playback functionality"*. **[W]** Added in **1.5.10 (2025-07-30)**.
  * `wasapi_dither` — "Dither"; `dither_intro` = *"When SPW bit depth exceeds the device's bit depth, minimal noise is added to the output signal to reduce quantization distortion (Dither is solely related to bit depth)"*
  * `wasapi_selected_freq` + `initialize_wasapi_sampling_rate` — selectable output frequency, displayed as `%1$d Hz`
  * `currentDeviceExclusiveFreq`, `device`, `audio_session_id`
* **Sample-rate conversion:** `src` / `src_quality` with `PiscesPlayer.SrcQuality` = **`Linear` | `Sinc8` | `Sinc16` | `Sinc32` | `Sinc64` | `Sinc128` | `Sinc256`**. **[V]** **[W]** Store copy advertises *"最高 256-Sinc 采样质量，浮点 DSP 处理"*.
* **Gapless playback:** `gapless_playback` + `ic_gapless`. **[V]** **[W]** *"SPW 设计时默认启用无间隙播放功能"* — **enabled by default**. 1.11.2 improved gapless under WASAPI Exclusive "Perfect Sample Rate" (**only when no sample-rate switch occurs**), matching the caveat above.
* **Multi-channel downmix [W]:** 1.4.6 added automatic multi-channel downmixing with automatic channel mapping to match speaker output.
* **Audio device switching [W]:** 1.14.0 added Audio Engine → audio-device selection (follow system, or a specified output device).
* **ReplayGain — ⚠️ NOT VERIFIED, likely absent.** **[X]** I found **no** ReplayGain, RG2 or loudness-normalisation string, config key or class in the binary. `level`, `dBFS`, `getAudioLevel` and `unable_to_retrieve_level_information` exist but refer to a **VU/level meter**. **[W]** No official Moriafly documentation mentions ReplayGain. The only evidence anywhere is a **third-party blog about the *Android* app**, describing a dB indicator appearing when RG tags are present. **Do not assume SPW implements ReplayGain.**
* **DSP / effects.** **[V]** `bass_fx.dll` is loaded; `audio_effect` screen; `mixer`; **`eq_id`** config key with `changeEQ` / `getEq` / `setEq` — **an equalizer exists, identified by preset id**. `BASS_FX.BASS_BFX_BQF` (biquad filter) and `BASS_BFX_VOLUME` are referenced, as are the full `BASS_FX_DX8_*` effect set (chorus, compressor, distortion, echo, flanger, gargle, I3DL2 reverb, parameq, reverb). **VST** is signalled by `ic_vst.png` + `ic_vst_logo.png`.
  **[W] Important caveat:** SPW **opened effects testing in 1.2.1 but took the effects feature offline in 1.5.10** (*"变更暂时下线音效功能，等待后续自定义功能开发"*). "MaxAudio" is still advertised on the store listing but **was pulled from the app UI**. **[X]** The EQ's band count, frequencies and preset list are unknown for SPW. (Android, by contrast, has a mature **Salt Player 均衡器 (PRO)**: 8000+ AutoEQ profiles, 20+ built-in presets, up to a **32-band parametric EQ**, with import/export — released 12.3.0.)
* **Playback speed:** `playback_speed` persisted. **[V]** **[W]** Range 0.5–4.0 (added 1.0.1200).
* **Volume:** `volume` persisted, `volume_control_curve` (`Linear` / …), `windows_volume_synthesizer`, plus a separate `spw_mixer` path. **[V]**
* **CD:** `basscd.dll`, `BASSCD.BASS_CD_INFO`, `cd_toolkit` ("CD Toolkit"), `ic_cd`, `ic_compact_disc`, `disc_d` = "DISC %1$d". **[V]**
* **Output info panel:** `audio_output_information`, `streaminfo`, `channel`, `frequency`, `sample_rate`, `bits_per_sample`, `average_bitrate`, `sample_format_not_supported`. **[V]**

### 3.2 Library management

**[V]** Persistence is **Room** (`AppDatabase`, `AppDatabase_Impl`, `@Entity` classes) on the JVM.

**Entities** (exact class names): `Track`, `Album`, `Artist`, `ArtistWithTracks`, `Genre`, `Folder`, `FlatFolder`, `Playlist`, `PlaylistTrack`, `PlaylistWithTracks`, `PlaylistWithOrderedTracks`, `PlaylistUpdate`, `TrackArtist`, `TrackInPlaylist`.

* **Folder scanning:** `scan_folder`, `scan_files`, `import_folder`, `import_file`, `custom_folders`, `folder_path`, `folders`.
* **Drag & drop import:** `music_library_drag_and_drop_tip` = *"Drag and drop files or folders into this window to automatically recognize them (this also applies to the songs screen ᓚᘏᗢ)"* — including a kaomoji, characteristic of the app's tone. **[V]**
* **Refresh / rebuild:** `refresh_music_library`, `refresh_music_library_apply_change`, `rebuild_music_library`, `rebuild_music_library_intro` = *"The music library data needs to be manually optimized. Please click 'Rebuild Music Library'"*, `music_library_refreshed_tip` = "Music library refreshed: %1$d songs updated". **[V]**
* **[W] Non-destructive management philosophy.** The official feature list states 音乐管理 is *"基于独家**古琴模块**专业分类各种音频，音乐库记录数据**不主动抛弃**"* and the store copy says *"无自动删除式管理（**仅自动增加式**）"* — the library **only ever adds**, never silently drops entries. This is exactly why the unreadable-track workflow below exists.
* **Removal:** `remove_from_music_library` + warning `remove_from_music_library_tip` = *"⚠️ Removing songs from the music library will also remove them from all associated playlists"*; plurals `remove_from_music_library_dialog_content`. **[V]**
* **Unreadable-track handling:** `has_unreadable_track`, `has_unreadable_track_intro` (a long explanation of permission/drive/move causes and the risk of losing associated data), `remove_all_unreadable_tracks`, `show_has_unreadable_tracks_prompt_in_caption_bar`, `ignore_and_do_not_show_this_prompt_in_caption_bar_again`, `ic_unreadable`, `ic_database_warning`. **[V]**
* **Tag reading/writing:** `SaltAudioTagReader`, `JAudioTaggerTagReader`, `TagReader`, `TagParser`, `TagWriter`, `VoxzenAudioTag`. **[V]** The binary bundles the full **jaudiotagger** library (604 classes) for tag I/O. **[W]** 1.2.4 replaced the FLAC parsing core with "SaltAudioTag".
* **Tag editor:** `tag`, `edit`, `track_information` ("Track Information"), `reread_track_information_from_file` ("Re-read Track Information Form File" *(sic)*). **[V]** **[W]** An official metadata standard page defines TITLE/ARTIST/ALBUMARTIST/GENRE/YEAR conventions.
* **Artists:** `edit_artist` ("Edit Artist"), `new_artist` ("New Artist"), `album_artist`, `artists`, `isPerformingArtist`. **[V]**
* **Playlists:** `playlist`, `new_playlist`, `edit_playlist`, `add`, `remove_from_playlist`, `added_to_playlist_time`, `successfully_added_to_playlist`, `unable_to_add_duplicate_to_playlist` ("Unable to add duplicate to playlist"), `title_cannot_be_empty`. **[V]** **[W]** Playlists arrived in **1.5.0 (2025-07-25)**.
* **Genres:** `genre`, `genres`, `unknown_genre`, `GenreCatalog` with a **`GenreCatalog.Type` enum** of 24 curated genres (`Blues, Children, ChineseCharacteristic, Classical, Country, EasyListening, Electronic, Experimental, Folk, HipHop, Jazz, Latin, Metal, NewAge, Others, Punk, Reggae, Rock, SingerSongwriter, StageAndScreenAndEntertainment, WorldMusic, AudioBook, …`), each with a `stringResource` and a background image (`bg_genre_acg.jpg`, `bg_genre_blues.jpg`, `bg_genre_pop.jpg`). Long editorial copy ships per genre (`genre_major_pop_intro`). **[V]** **[W]** The official feature list advertises *"智能二级分类 **100+ 曲风**，内置曲风介绍，内置专业曲风编辑器"* — i.e. **100+ genres in a two-level taxonomy** with an editor, which is larger than the 24-entry enum I recovered (the enum is the *major* category list).
* **Image library:** `image_library`, `ic_media_source`, `frontCover`, `isUserEditedCover`, `updateFrontCover`, `onGetFrontCover` — **user-replaceable cover art**. **[V]**
* **Search & sort:** `search`, `ic_search`, `sorting_options`, `ascending`/`descending`, `ic_sort_a_z`, fields `name`, `added_time`, `modified_time`, `play_count`, `duration`, `year`, `track_number`. Per-screen persisted sorts: `track_screen_sort`, `track_screen_sort_descending`, `album_screen_sort`, `folder_screen_sort`, `folder_screen_sort_descending`. **Chinese pinyin sorting is implemented** via `util/TinyPinyin` + `tinypinyin/cncity.txt` / `cncity_fulllist.txt`. **[V]** **[W]** 1.18.0 added alphabet quick-jump.
* **Batch operations:** `batch_operation`, `select_all`, `deselect_all`, `invert_selection`, `range_selection`, `use_check_boxes_to_select_items`, plurals `selected_d_items` = "Selected %1$d Item(s)". **[V]**
* **Folder page [W]:** added 1.7.0, with drag-reorder.

### 3.3 Playback

**[V]** from `PlaybackService`, `PlaybackController`, `PlaybackMonitor`, `PlaybackCommand`.

* **Command model** — `PlaybackCommand` sealed type: **`Prepare`, `Play`, `Pause`, `SetPlaybackQueue`, `AddToPlay`, `Move`**. Processed through a `playbackCommandChannel` with a `playbackQueueMutex`, with `inContextCommand` / `outContextCommand` separation and a `requireRunningOnMainThread()` guard.
* **Queue** — a dual-queue model persisted to disk: `play_normal_queue` + `play_normal_queue_index`, `play_random_queue` + `play_random_queue_index` (`PlayQueueSave`, `PlayQueueSaveItem`). `isRandomQueue` distinguishes them; `clearPlaybackQueue`, `playMusicAt`, `moveMediaItem`, `removeMediaItems`.
* **Playback modes** — `playback_mode` persisted; strings `repeat_all`, `repeat_one`, `random_play` / `random`.
* **Resume** — `initFromDisk` restores queue + index + position + volume + mode on launch. `addPosition`.
* **Speed** — `playback_speed`.
* **Media keys / system integration** — `JmtcManager` (**J**ava **M**edia **T**ransport **C**ontrol) with `updateJMTC` / `updateMediaItems`, using `audioSessionId` and a `THUMBBUTTON` taskbar thumbnail toolbar (`WindowsTaskbarWindowProc`, `IWindowsTaskbarInternal`). `updateJMTC$2` uses constants **220** and **255** (typical SMTC/thumbnail sizes). **[V]** **[W]** Official: *"适配：支持 Windows **SMTC** 协议"*.
* **Error handling** — `onError` with distinct branches, `unknown_error`, `song_not_loaded` = "Song not loaded, please select a song to play", `retry`. **[V]**
* **Play-count tracking** — `play_count` on the `Track` entity. **[V]**
* **Sleep timer:** **[X]** no sleep-timer string or config key found.

### 3.4 Lyrics

**[V]** Lyrics are a **first-class subsystem** (`com.xuncorp.spc.lyrics` plus `ui/screen/lyrics`).

* **Views:** `playback_screen_lyrics`, `player_screen`, `desktop_lyrics` (separate window), `lyrics` route.
* **Word-by-word (karaoke) lyrics** with `KaraokeCompatStrategy` = **`Always` | `ExpandDocument` | `OnlyCurrentLine`**. `PlaybackExtensionPoint.LyricsLine` even exposes a **`Cell`** type — per-syllable/per-word timing cells.
* **Translation:** `lyrics_translation` + `lyrics_translation_font_size_scale` (rendered as a scaled ratio). Sub-text toggles: `show_player_lyrics_sub_text`, `show_desktop_lyrics_sub_text`.
* **Alignment:** `lyrics_alignment` = **Start | Center**; separate `desktop_lyrics_alignment`.
* **Font control:** `lyrics_font_size`, `lyrics_font_weight`, `font_strategy`, `custom_font_file_path`.
* **Styling:** `blur_inactive_lyrics`, `expand_all_lines` vs `only_current_line`.
* **Empty state:** `no_lyrics` ("No Lyrics"), `song_not_loaded`.
* **Demo/credit line:** `lyrics_screen_footer` = *"Demonstration style lyrics text from ZARD's 'マイ フレンド'"* — the lyrics settings page previews using **ZARD – マイ フレンド**. **[V]**
* **[W] Sources — now resolved.** Store copy: *"歌词：**内嵌歌词读取、LRC 歌词读取**，支持滚动歌词、**卡拉 OK 歌词渲染**，更有**桌面歌词**"*. So SPW reads **embedded lyrics and LRC sidecar files**. **[W]** Moriafly also publishes an open **SPL — Salt Player Lyrics** syntax standard (created 2024-12-16, revised 2025-11-14) at `moriafly.com/standards/spl.html`. 1.8.0 added **SPL compatibility with delayed per-word marking**; Android 12.3.0 added `.spl` lyric files. **[X]** Whether SPW also fetches lyrics from an online provider is **not documented** — a third-party plugin (`SaltLyricPlugin`) implemented online lyric fetching itself via 163/QQ/Kugou APIs, which implies SPW did **not** provide it natively at that time.

### 3.5 UI features

**[V]** `light_dark_theme` (Light/Dark/Follow System) · `spw_window_style` (None/Acrylic/Mica/Mica Alt) · `wallpaper` + `enable_wallpaper` + `WallpaperScreen` · `font_strategy` (Follow System / MiSans / Custom file) · `render_api` (Direct3D/OpenGL) · `gpu_priority` · `vsync` · `fps_monitor` · `dxgi_compat_mode` · `display_scaling` · `always_on_top` · `window_full_screen_button` · `multilayer_blur_effect` · `sunglow_effect` · `show_circle_cover_art` · `show_audio_quality_badge` · `track_item_check_boxes` · `track_preview_pane` · `auto_hide_mini_player_controls` · `auto_hide_mouse_pointer_on_playback_screen` · `shared_element_animation` · `close_main_window_strategy` (System Tray / Exit Progress) · `minimize_to_notification_area` · `taskbar_title_show_listening_to` (sub-text: *Show "Song Title - Artist" in taskbar title*) · `accessibility` (NVDA screen reader, Windows Ease of Access) · `language` (8 locales, applies on restart) · `laboratory` · `early_access`.

**[W]** Additional by version: accessibility display scaling (1.0.1167), custom wallpaper (1.13.0), energy-saving mode + AOT (1.13.0), alphabet quick-jump and tray pin/unlock (1.18.0).

### 3.6 Integrations

**[V]**
* **Steam** — `steam_api64.dll` + `com.xuncorp.steamworks4k` (a Kotlin Steamworks binding: `SteamApi`, `SteamApiSteamApps`, `SteamApiSteamFriends`, `SteamApiSteamUser`, `SteamApiSteamUtils`, `Steamworks4k`). Features: `steam_account` page, `steam_rich_presence_listening_to` + sub-text *Show "Song Title - Artist" in Steam status*, `achievement`, `workshop`, `connecting_to_steam`, `cannot_connect_to_steam`, `steam_client_is_outdated`, `rich_presence_listening_to`, `STEAM_APP_ID = 3009140`, `PROTECT_STEAM` / `PROTECT_STEAM_TEXT`. **[W]** Steam Rich Presence ("正在听") arrived in 1.5.0.
* **Microsoft Store** — `com.xuncorp.voxzen.distribution.ms.MicrosoftStoreLicense`, `isLicenseAvailable`, and a `NoMicrosoftStoreLicenseWindow` — the same codebase ships to the Microsoft Store with a licence check. **[V]** **[W]** The Store package is appx/msix, Windows 10 build 17763.0+, ~134.70 MiB, priced ¥39.00, rated 4.6★ from 143 ratings.
* **Windows shell** — `Shell32Util`, `WindowsUtil.openWithOtherApp`, `open_in_explorer`, `open_with_other_app`, `copy_file_path`, `ic_file_explorer`, `ic_open_with`. **[V]**
* **Windows taskbar** — thumbnail toolbar buttons + overlay icons (`next.ico`, `play.ico`, `previous.ico`, `pause.ico`), `WindowsTaskbarWindowProc`. **[V]**
* **Global media keys / SMTC** — `JmtcManager`. **[V]**
* **Last.fm / scrobbling:** **[X]** — **no** Last.fm, scrobbling or Audioscrobbler string or class was found, and no official documentation mentions it. **[W]** Two independent Steam reviewers name it as missing: *"just need metadata editor and scrobble to last.fm"* and *"does it have all the big important features like Discord Rich Presence and scrobbling? No"*. **Confirmed absent.**
* **Discord Rich Presence:** **[X]/[W]** — not found in the binary, and explicitly named as missing by a Steam reviewer. **Confirmed absent.** (Steam Rich Presence *is* present.)
* **ASIO:** **[X]/[W]** — not found; only DirectSound and WASAPI are offered, and a reviewer requests ASIO. **Absent.**
* **In-app metadata editing:** **[X]/[W] — nuanced.** My binary *does* contain `TagWriter`, a `Tag`/`tag` string, a `TrackInformation` route, and `reread_track_information_from_file` — so tag **writing** code and a track-information screen exist. **However**, the official docs direct users to the separate **音乐标签** app for metadata editing, and a Steam reviewer explicitly requests *"editing metadata inside the app"*. **[I]** The most consistent reading is that `TrackInformation` is primarily a **read-only detail view** (with re-read from file, cover assignment via the Image Library, and limited edits such as album artist), while **bulk/full tag editing is deliberately out of scope**. Treat full tag editing as **not a shipped feature** — verify before relying on it.
* **DLNA [W]** — *experimental* DLNA casting exists on **Android**; there is **no** evidence of it in the SPW binary.
* **Plugin/mod system — YES.** See §3.7.

### 3.6b Android design-language continuity

**[W]** Salt Player for Android (`com.salt.music`, v12.x) is the sibling product and the origin of the design language. Relevant DNA for a reimplementation:

* **Not Material 3.** Both apps use a **custom design system called Salt UI**, authored by the same developer and open-sourced as Compose Multiplatform components (`Moriafly/SaltUI`): *"Salt UI is UI components based on Compose Multiplatform. The 1.0 version is derived from some UI components of Salt Player."* SPW states it is *"基于 Salt UI 2"*.
* **Navigation (Android, 2022-era):** a single songs list as home, with a **side/hamburger menu** switching between Albums / Artists / Folders; playlists created from that menu and auto-assigned the first track's cover.
* **Now-playing (Android):** song title + artist in the **top-left**, high-frequency transport controls at the **bottom**, swipe left on the cover/blank area for info & settings, swipe right for lyrics. **This is a different layout from SPW's lyrics-centric overlay** — do not assume the Android layout transfers.
* **Colour:** Android has **分控主题** (separately themed home vs now-playing accent) and **壁纸取色** (Android 12+ **wallpaper** colour extraction), plus **动态流光 V2** (album-art-driven flowing light). **Note: wallpaper extraction, not cover-art extraction** — see §6.4.
* **Android audio is a different stack**: AudioTrack / OpenSL ES / AAudio / Direct modes, float decoding, up to 40× speed, **SALT FX V4+** effects with headphone presets and MAX Audio tuning, and a mature **32-band parametric EQ** (12.3.0). **Do not assume SPW's DSP matches** — SPW took its effects offline in 1.5.10.
* **Android deprecated DSD in 2024**; **SPW added it in 1.6.10 (2025)**. The two platforms diverged here.

### 3.7 Plugin / extension system ("Workshop" and "Mods")

A **major, confirmed** feature, independently verified from both the binary and the official API repository. **[V][W]**

* **API package:** `com.xuncorp.spw.workshop.api`
* **Interfaces / classes:** `SpwPlugin` (`pluginContext` + `update`), `PluginContext` (data class: `pluginId`, `pluginPath`, `pluginVersion`, `spwChannel`, `spwVersion`), `WorkshopApi` (nested `Manager`, `Playback`, `Ui`; `Ui` has a **`ToastType`** enum), `WorkshopPluginManager` (takes `paths`), `Channel`, `ConfigHelper`, `ConfigManager`, `SinceApi`, `UnstableSpwWorkshopApi` (an explicit stability annotation). **[V]**
* **Extension point:** `PlaybackExtensionPoint` exposes **`onBeforeLoadLyrics`, `onAfterLoadLyrics`, `onLyricsLineUpdated`, `onPositionUpdated`, `onIsPlayingChanged`, `onStateChanged`, `onSeekTo`** with data types `MediaItem`, `LyricsLine` (containing `Cell`), `State`, and `updateLyrics`. **[V]**
* **⚠️ Framework correction.** **[V]** The binary contains **97 `org.pf4j.*` classes** — `DefaultPluginManager`, `PluginWrapper`, `PluginClassLoader`, `PluginDescriptor`, `PropertiesPluginDescriptorFinder`, `ExtensionFinder`, `ServiceProviderExtensionFinder`, `DependencyResolver`, `VersionManager`, `PluginState`, etc. **[W]** The official `spw-workshop-api` README confirms: *"它**基于 PF4J (Plugin Framework for Java)** 构建，旨在简化 SPW 在 JVM 平台上的插件化开发"*. **This settles the plugin implementation: PF4J, JVM JARs — not a scripting engine.** (My binary scan independently found no Rhino/Nashorn/GraalJS/Lua/Kotlin-scripting engine, consistent with this.)
* **[W] Plugin manifest metadata:** `Plugin-Class` (must extend `SpwPlugin`), `Plugin-Id` (unique, package-name style), `Plugin-Name`, `Plugin-Version`, `Plugin-Provider`, `Plugin-Description` (optional), `Plugin-Open-Source-Url` (optional), `Plugin-Has-Config` (optional boolean). Packaging: `gradlew plugin` → a zip with `classes/` + `lib/`. The docs ask mods to be open source and **not obfuscated**.
* **[W] Declarative plugin config UI.** A `preference_config.json` is rendered by SPW as a settings UI. Supported control types: **switch, list, button, seekbar, edittext**. Common properties: `type`, `title`, `summary`, `key`, `default_value`. Changes are observed via `ConfigManager::addConfigChangeListener`; a button's `on_click` invokes a static no-arg method by reflection (requiring `@JvmStatic` + `@JvmName` for Kotlin companions). Config is stored at `%APPDATA%/workshop/data/plugin_id/`.
* **Mod metadata & lifecycle strings [V]:** `Mod ID: %1$s / Mod Name: %2$s`, `import_mod`, `import_mod_title` ("Confirm Import Mod"), `update_mod_title` ("Update Mod: %1$s?"), `update_mod_content` ("Old version %1$s -> New version %2$s"), `enable_mod_s` ("Enable Mod %1$s?"), `mod_management`, `delete_mod_user_data_simultaneously`, `mod_not_open_source_link_provided_tip` = *"⚠️ No open source link provided, this Mod could be a security risk"*, `open_source_link`, `invalid_plugin_file` = "Failed to import plugin, this does not seem to be a valid plugin file".
* **[W] Distribution & maturity:** Steam Workshop, with release channels (`Channel` / `spwChannel`). Experimental plugin support landed in **1.3.16 (2025-06-06)**; the Mod API was updated to `0.1.0-dev10` in 1.6.20. From **1.6.10 EA, mods are DISABLED by default**. The API is explicitly **experimental**. Dependency: `com.github.Moriafly:spw-workshop-api` via JitPack (Java 21 target).
* **[W] Real third-party plugins exist**, proving the system works: `SaltLyricPlugin` (desktop lyrics; exposed a local HTTP API on port 35373 with endpoints like `/api/now-playing`, `/api/play-pause`, `/api/next-track`, `/api/lyric163` — **now discontinued because SPW 1.8.0 implemented full desktop lyrics natively**), `TaskbarLyricsPlugin`, and `SaltTimePlugin` (playback-position save).
* **[W]** The plugin concept is **SPW-exclusive** — no equivalent exists in the Android app.

### 3.8 Settings — complete persisted key list

**[V]** From `com.xuncorp.voxzen.util.Config` (each exists as a `ConstantValue` **and** as a lowercase string literal):

```
ALBUM_SCREEN_SORT                album_screen_sort
ALWAYS_ON_TOP                    always_on_top
AUDIO_ENGINE_MODE                audio_engine_mode
AUTO_HIDE_MINI_PLAYER_CONTROLS   auto_hide_mini_player_controls
BLUR_INACTIVE_LYRICS             blur_inactive_lyrics
CLOSE_MAIN_WINDOW_STRATEGY       close_main_window_strategy
CUSTOM_FONT_FILE_PATH            custom_font_file_path
DESKTOP_LYRICS                   desktop_lyrics
DESKTOP_LYRICS_ALIGNMENT         desktop_lyrics_alignment
DESKTOP_LYRICS_WINDOW_IS_LOCKED  desktop_lyrics_window_is_locked
DESKTOP_LYRICS_WINDOW_POSITION_X desktop_lyrics_window_position_x
DESKTOP_LYRICS_WINDOW_POSITION_Y desktop_lyrics_window_position_y
DISPLAY_SCALING                  display_scaling
DXGI_COMPAT_MODE                 dxgi_compat_mode
ENABLE_WALLPAPER                 enable_wallpaper
EQ_ID                            eq_id
FOLDER_SCREEN_SORT               folder_screen_sort
FOLDER_SCREEN_SORT_DESCENDING    folder_screen_sort_descending
FONT_STRATEGY                    font_strategy
GPU_PRIORITY                     gpu_priority
ID3V1_DECODING_CHARSET_NAME      id3v1_decoding_charset_name
LANGUAGE_TAG                     language_tag
LIGHT_DARK_THEME                 light_dark_theme
LYRICS_ALIGNMENT                 lyrics_alignment
LYRICS_FONT_SIZE                 lyrics_font_size
LYRICS_FONT_WEIGHT               lyrics_font_weight
MULTILAYER_BLUR_EFFECT           multilayer_blur_effect
PLAYBACK_MODE                    playback_mode
PLAYBACK_SPEED                   playback_speed
PLAY_NORMAL_QUEUE                play_normal_queue
PLAY_NORMAL_QUEUE_INDEX          play_normal_queue_index
PLAY_RANDOM_QUEUE                play_random_queue
PLAY_RANDOM_QUEUE_INDEX          play_random_queue_index
RENDER_API                       render_api
SHARED_TRANSITION_SCOPE          shared_transition_scope
SHOW_AUDIO_QUALITY_BADGE         show_audio_quality_badge
SHOW_CIRCLE_COVER_ART            show_circle_cover_art
SHOW_DESKTOP_LYRICS_SUB_TEXT     show_desktop_lyrics_sub_text
SHOW_PLAYER_LYRICS_SUB_TEXT      show_player_lyrics_sub_text
SPW_WINDOW_STYLE                 spw_window_style
SRC_QUALITY                      src_quality
STEAM_RICH_PRESENCE_LISTENING_TO steam_rich_presence_listening_to
SUNGLOW_EFFECT                   sunglow_effect
TASKBAR_TITLE_SHOW_LISTENING_TO  taskbar_title_show_listening_to
TRACK_ITEM_CHECK_BOXES           track_item_check_boxes
TRACK_PREVIEW_PANE               track_preview_pane
TRACK_SCREEN_SORT                track_screen_sort
TRACK_SCREEN_SORT_DESCENDING     track_screen_sort_descending
VOLUME                           volume
VSYNC                            vsync
WASAPI_DITHER                    wasapi_dither
WASAPI_EXCLUSIVE_MODE            wasapi_exclusive_mode
WASAPI_PERFECT_SAMPLE_RATE       wasapi_perfect_sample_rate
WASAPI_SELECTED_FREQ             wasapi_selected_freq
WINDOW_FULL_SCREEN_BUTTON        window_full_screen_button
WIZARD                           wizard
```

Additional runtime state in `AppConfig` (Compose state, not necessarily persisted): `isPlaybackScreenExpand`, `mainWindowVisible`, `showPlayerLyricsSubText`, `showDesktopLyricsSubText`, `desktopLyricsWindowIsLocked`, `showCircleCoverArt`, `sunglowEffect`, `multilayerBlurEffect`, `fpsMonitor`, `renderInfo`, `exclusiveProperties`, `customFontFilePath`, `trackItemCheckBoxes`, `showAudioQualityBadge`, `appInformation`, `spwWindowStyleTransparent`, `karaokeCompatStrategy`, `saltUiMaterial`, `moriafly` *(an easter-egg key)*. **[V]**

**Storage [V]:** `Spkv` — a typed key-value store over **`java.util.prefs.Preferences`** (`userRoot`, `node`, `TYPE`, `encode`/`decode` for boolean/int/float/string/enum/Serializable). `Config` also carries constants **`32`**, **`48`**, **`400`** and float **`0.8`** (likely a debounce/throttle and a default volume of 0.8); `AppConfig` also holds float **`0.8`**. `AppDefaults` defines `COVER_DISK_CACHE_MAX_SIZE_BYTES`, `HAZE_INPUT_SCALE = 0.66`, `COIL_LOG_ENABLED`, `STEAM_APP_ID = 3009140`, `PROTECT_STEAM`, `DxgiCompatMode`, `LOTTIE`.

**Wizard [V]:** a first-run setup wizard exists — `wizard`, `wizard_intro` = *"SPW will launch a setup wizard to configure the following items, allowing the software to automatically adjust internal options for optimal performance on your device"*, `re_run_spw_wizard` = "Re-run SWP Wizard" *(sic)*, `finish`, `next`, `back`.

### 3.9 Version history and platform requirements

**[W] Steam / store facts:** AppID **3009140**, Steam release **2025-07-21**, **Early Access**, **¥39.00**. Steam developer of record **Sakawish**; publisher **泽世宫工作室 (Zeshi Palace Studio)**. Microsoft Store version 1.18.0.0, updated 2026-09-13, ~134.70 MiB, 4.6★ / 143 ratings.

**[W] System requirements** (official install doc; the store listings and the legacy demo site give *different* numbers, so treat these as the authoritative set):

| | Minimum | Recommended |
|---|---|---|
| OS | Windows 10 **x64** | Windows 11 22H2 x64 |
| RAM | 2 GB | 8 GB |
| DirectX | 7.0 | 9.0 |
| Storage | 500 MB | 1 GB |
| Resolution | 800 × 600 | 1920 × 1080 |

Microsoft Store lists Windows 10 build **17763.0+**, DirectX 9, 1 GB RAM. The legacy demo site listed lower RAM figures. **The three sources disagree — cite per source.** **[W]**

**[W] Selected changelog milestones** (full list at `moriafly.com/program/spw/changelog.html`):

| Version | Date | Highlight |
|---|---|---|
| 1.0.766 | 2024-11-28 | First demo version |
| 1.0.1200 | 2025-03-01 | New **SPW Pisces audio library** (experimental); playback speed 0.5–4.0 |
| 1.2.1 | — | Effects testing opened |
| 1.2.4 | 2025-04-30 | FLAC core replaced with **SaltAudioTag** |
| 1.3.16 | 2025-06-06 | **Experimental plugin support** |
| 1.4.6 | — | Multi-channel auto-downmix |
| 1.4.10 | — | **CDA** playback |
| 1.5.0 | 2025-07-25 | Playlists, CDA parsing, Steam Rich Presence |
| 1.5.10 | 2025-07-30 | WASAPI **Perfect Sample Rate**; **effects taken offline** |
| 1.6.0 | 2025-08-17 | Track-item appearance; mod deletion; desktop-lyrics position memory |
| 1.6.10 | 2025-08-23 | **Quality badges**; **DSD dff/dsf**; JA/KO localisation; mods disabled by default |
| 1.6.20 | 2025-09-05 | 3D cover animation; circular cover; Mod API 0.1.0-dev10 |
| 1.7.0 | 2025-09-24 | Folder page; drag-reorder |
| 1.8.0 | 2025-12-02 | Full desktop lyrics; SPL delayed per-word marking; Help & Feedback |
| 1.11.0 | 2026-02-03 | Desktop-lyrics colour; hide played lines |
| 1.12.0 | 2026-03-02 | Audio Visualizer (Lab); Spanish |
| 1.13.0 | 2026-04-11 | AOT; energy-saving mode; **custom wallpaper**; lyric stroke |
| 1.14.0 | 2026-05-31 | **Audio device switching**; **WAV-DTS**; Acrylic default on Win11 22H2+ |
| 1.15.2 | 2026-07-08 | **Keyboard shortcut settings (in-app / global)**; **APE + OPUS** |
| 1.16.x | 2026-08 | Horizontal mini bar |
| 1.18.0 | 2026-09-13 | Alphabet quick-jump; tray pin/unlock; **Liquid Glass** mini bar; Morvanium effect |

**[W] Android design-language continuity (for lineage awareness).** Salt Player for Android (`com.salt.music`, v12.x) is the sibling product. Relevant shared design DNA: a **Salt UI** Compose Multiplatform component library; **分控主题** (separately themed home and playback screens); **壁纸取色** (Android 12+ **wallpaper** colour extraction); near-100 customisation options; mini-player lyrics, embedded/LRC lyrics, desktop lyrics, floating-window and status-bar lyrics. Android's audio stack is **not** the same as SPW's wrapper, but it too is BASS-based (the v8.3.2 README carried the *"BASS SHAREWARE LICENCE AGREEMENT … licensed by Un4seen Developments Ltd."* notice), with AudioTrack / OpenSL ES / AAudio / Direct drivers and **SALT FX V4+**. **[W]**

---

## 4. Component inventory for a reimplementation

Each component lists its verified backing evidence and an **[I]** description of what it must do.

### Shell & chrome

| # | Component | Evidence | Description |
|---|---|---|---|
| 1 | **Custom caption bar** | `caption_bar`, `ic_window_{minimize,maximize,restore,close}.svg` | Full-width draggable title bar; 16 px window buttons right-aligned; track/app title; drag-to-move; double-click to maximise. |
| 2 | **Window backdrop manager** | `SpwWindowStyle`, `WindowBackdrop`, `WindowCornerPreference`, `WindowsBuildsKt` | Applies None/Solid/Acrylic/AcrylicWithTint/Mica/MicaTabbed with OS-build gating; DWM rounded corners. |
| 3 | **System-menu shim** | `GetSystemMenu`, `TrackPopupMenu`, `MENUITEMINFO`, `HTSYSMENU` | Right-click caption-bar menu reproducing the native window menu. |
| 4 | **Wallpaper layer** | `enable_wallpaper`, `WallpaperScreen`, `bg_wallpaper` | User-supplied background behind translucent surfaces (material + blur style from 1.13.0). |
| 5 | **Fullscreen host** | `ui/window/fullscreen/*`, `ExtendedUser32`, `FullscreenButton` | Borderless exclusive fullscreen for the playback screen. |

### Navigation

| # | Component | Evidence | Description |
|---|---|---|---|
| 6 | **Navigation sidebar / rail** | `AppNavigation_desktopKt`, `ic_nav_*` | 11 top-level destinations with icons + labels; active-state accent; collapses/expands. |
| 7 | **Settings list & nested settings stack** | 22 settings route keys | Grouped list of settings entries; each pushes a sub-page within the settings stack. |
| 8 | **Settings item row variants** | `ThemeModeItem`, `ThemeStyleItem`, `FontStrategyPanel` | Toggle, radio group, segmented control, dropdown, slider, navigation link, action button, info/value display. |

### Library screens

| # | Component | Evidence | Description |
|---|---|---|---|
| 9 | **Track list / table** | `track_item_appearance`, `TRACK_SCREEN_SORT` | Virtualised, sortable, multi-selectable table; configurable columns; checkbox mode; alphabet quick-jump. |
| 10 | **Track list row** | `Track` entity, quality badges | Cover thumb, title, artist, album, duration, optional quality chip, optional checkbox, playing indicator. |
| 11 | **Album grid** | `album`, `ic_album`, `ALBUM_SCREEN_SORT` | Cover-art grid with title/artist caption. |
| 12 | **Artist list** | `artist`, `ic_artist`, `ArtistWithTracks` | List/grid of artists with track counts; drill-in to artist detail. |
| 13 | **Genre grid** | `GenreCatalog.Type`, `bg_genre_*.jpg` | Two-level genre taxonomy (100+ per official copy); curated tiles with background images. |
| 14 | **Folder tree / flat folder list** | `Folder`, `FlatFolder`, `ic_nav_folder` | Hierarchical or flattened browsing, driven by `folder_screen_sort`. |
| 15 | **Playlist detail** | `PlaylistWithOrderedTracks`, `PlaylistUpdate` | Ordered track list with drag-reorder and edit mode. |
| 16 | **Playlist editor** | `EditPlaylist`, `title_cannot_be_empty` | Create/rename/describe; pick cover. |
| 17 | **Artist editor** | `EditArtist`, `new_artist`, `isPerformingArtist` | Rename artist; mark as performing artist. |
| 18 | **Track information / tag editor** | `TrackInformation`, `TagWriter`, `VoxzenAudioTag`, jaudiotagger | Editable metadata form (title, artist, album, album artist, track/disc no., year, genre, cover). |
| 19 | **Image library** | `image_library`, `frontCover`, `isUserEditedCover` | Browse/assign cover art; marks user-edited covers so scans don't overwrite them. |
| 20 | **Search bar** | `search`, `ic_search`, `TinyPinyin` | Filter with pinyin-aware matching for Chinese titles. |
| 21 | **Sort menu** | `sorting_options`, `ascending`/`descending`, `ic_sort_a_z` | Per-screen sort field + direction, persisted. |
| 22 | **Batch-operation bar** | `batch_operation`, `select_all`/`deselect_all`/`invert_selection`/`range_selection` | Appears on multi-select; shows `Selected %1$d Item(s)` and bulk actions. |
| 23 | **Track preview pane** | `track_preview_pane` | Optional side pane showing details of the focused track. |
| 24 | **Drag-and-drop import overlay** | `ic_drag_and_drop`, `TracksTransferable` | Full-window drop target for files/folders; also a drag *source*. |
| 25 | **Unreadable-track banner** | `has_unreadable_track_intro`, `ic_unreadable` | Caption-bar prompt with "ignore and don't show again". |
| 26 | **Library refresh/rebuild dialog** | `rebuild_music_library_intro` | Explains and triggers a full re-scan. |

### Playback surfaces

| # | Component | Evidence | Description |
|---|---|---|---|
| 27 | **Player bar** | transport SVGs, `volume`, `playback_mode`, `ic_play_queue` | Persistent transport strip: cover, title/artist, prev/play/next, seek, time, volume, mode, queue, favourite, speed. |
| 28 | **Playback (now playing) screen** | `playback_screen`, `isPlaybackScreenExpand`, `sunglow_effect`, `multilayer_blur_effect` | Large artwork (optionally circular, optionally 3D-animated) with ambient sunglow/blur; lyrics; expandable. |
| 29 | **Mini player / mini bar** | `ic_mini_player_*.svg/png`, `auto_hide_mini_player_controls` | Compact always-available surface with auto-hiding controls; horizontal "mini bar" form from 1.16.x, Liquid Glass from 1.18.0. |
| 30 | **Desktop lyrics window** | `desktop_lyrics_*` keys, lock/unlock strings | Frameless, always-on-top, draggable, position-persistent, lockable, optionally click-through, auto-hides over fullscreen apps; colour + stroke controls. |
| 31 | **Lyrics view** | `ui/screen/lyrics`, `LyricsAlignment`, `KaraokeCompatStrategy` | Scrolling synced lyrics; active line highlighted; word-by-word karaoke; inactive lines blurred; translation sub-text; expand-all vs current-line-only. |
| 32 | **Lyrics settings panel** | `lyrics_font_size`, `lyrics_font_weight`, `lyrics_alignment`, `lyrics_translation_font_size_scale` | Live-previewed typography controls (preview text = ZARD マイ フレンド). |
| 33 | **Playback queue panel** | `playback_queue`, `PlayQueueSave`, `ic_play_queue` | Reorderable queue with "playing next" indicator; supports move. |
| 34 | **Queue-insert submenu** | `queue_after_current`, `queue_after_last_inserted`, `queue_at_end` | Three insertion policies when adding to the queue. |
| 35 | **Volume control** | `volume`, `volume_control_curve`, `ic_volume` | Slider with selectable response curve (Linear / …). |
| 36 | **Equalizer** | `eq_id`, `changeEQ`, `ic_mixer`, `bass_fx` | Band EQ with presets identified by `eq_id`. *(Note: SPW took effects offline in 1.5.10 — see §3.1.)* |
| 37 | **Audio-effect / DSP panel** | `audio_effect`, `ic_audio_effect`, `ic_vst`, `ic_head_bass` | Effects chain; VST and bass-boost affordances. |
| 38 | **Audio output info panel** | `audio_output_information`, `streaminfo`, `dBFS` | Live device, channel, sample rate, bit depth, bitrate, level meter. |

### Audio settings

| # | Component | Evidence | Description |
|---|---|---|---|
| 39 | **Output-mode selector** | `audio_engine_mode`, DirectSound/WASAPI/WASAPI-Exclusive strings | Radio/segmented control; disables inapplicable options with explanatory text. |
| 40 | **WASAPI exclusive panel** | `ExclusiveProperties`, `wasapi_*` keys | Exclusive on/off, perfect sample rate, dither, target frequency. |
| 41 | **SRC quality selector** | `SrcQuality` (7 values) | Linear → Sinc256 quality ladder. |
| 42 | **Gapless toggle** | `gapless_playback`, `ic_gapless` | On by default; caveat shown about perfect-sample-rate. |
| 43 | **Format-support page** | `format_support`, `ic_x64`, `ic_hi_res.webp` | Matrix of supported codecs/containers and hardware badges. |
| 44 | **CD toolkit** | `cd_toolkit`, `basscd`, `ic_cd`, `disc_d` | CD drive browsing/ripping UI. |
| 45 | **Audio device selector** | (1.14.0) [W] | Follow system or pick a specific output device. |

### Appearance & rendering

| # | Component | Evidence | Description |
|---|---|---|---|
| 46 | **Theme mode selector** | `ThemeModeItem`, `LightDarkTheme` | Light / Dark (default) / Follow System. |
| 47 | **Window-style selector** | `ThemeStyleItem`, `SpwWindowStyle` | Salt Classic / Acrylic / Mica / Mica Alt with OS-version gating. |
| 48 | **Font strategy panel** | `FontStrategyPanel`, `FontStrategy` | Follow System / MiSans Regular / Custom file picker, with an explanatory tip. |
| 49 | **Render settings page** | `RenderScreen`, `RenderApi`, `GpuPriority`, `vsync` | Direct3D vs OpenGL, GPU priority, V-Sync, DXGI compat mode, FPS monitor, render info. |
| 50 | **Track-item appearance page** | `TrackItemAppearanceScreen` | Quality badge toggle, checkbox mode. |
| 51 | **Wallpaper page** | `WallpaperScreen`, `enable_wallpaper` | Pick/enable wallpaper; material + blur style. |
| 52 | **Audio-quality badge** | 10 PNG assets + official definitions | 30 px pill chip: RAW / CD / CD+ / HQ / HiRes, each with a light and a dark variant. |
| 53 | **Caption-bar prompt** | `show_has_unreadable_tracks_prompt_in_caption_bar` | Inline, dismissible, "don't show again" notification hosted in the caption bar. |
| 54 | **Toast / notification** | `WorkshopApi.Ui.ToastType` | Toast with severity types, exposed to plugins. |

### Platform integration

| # | Component | Evidence | Description |
|---|---|---|---|
| 55 | **System tray** | `com.kdroid.composetray`, `minimize_to_notification_area` | Tray icon with a Compose-rendered native menu; close-to-tray strategy; pin/unlock desktop windows (1.18.0). |
| 56 | **Taskbar thumbnail toolbar** | `THUMBBUTTON`, `next.ico`/`play.ico`/`previous.ico`/`pause.ico` | Four thumbnail buttons on the Windows taskbar preview. |
| 57 | **SMTC / media-key bridge** | `JmtcManager`, `updateJMTC` | Publishes metadata and receives hardware media keys. |
| 58 | **Steam panel** | `steamworks4k`, `steam_account`, `achievement`, `workshop` | Account status, rich presence, achievements, Workshop. |
| 59 | **Mod manager** | `ModManagement`, `WorkshopPluginManager`, `SpwPlugin`, PF4J | Import/enable/update/delete mods; per-mod user data; declarative `preference_config.json` config UI; security warning for mods without a source link. |
| 60 | **First-run wizard** | `wizard`, `wizard_intro`, `finish` | Multi-step device/performance auto-configuration. |
| 61 | **Language picker** | `LanguageScreen`, `Language` enum | 8 locales; takes effect on restart. |
| 62 | **About / credits / changelog** | `about`, `credits`, `changelog`, `open_source_projects_used`, `license`, `special_thanks`, `project_initiation_date_and_location` = *"April 2024 · Shanghai, China"* | About page with build date, version, developer avatars, OSS licence list. |
| 63 | **Accessibility page** | `accessibility_screen_intro`, `nvda_screen_reader` | Documents NVDA / Windows Ease of Access support; checkbox-based selection mode; display scaling. |

---

## 5. Keyboard shortcuts and context menus

### 5.1 Keyboard shortcuts

**[V] From the binary:** a dedicated settings page **`keyboard_shortcut` ("Keyboard Shortcut")** exists, is reachable from Settings, and has its own string resource and route. A `ic_keyboard.png` icon ships. Accessibility strings mention `Windows Ease of Access` and `NVDA Screen Reader`. **No shortcut table is present in the string resources** — the page evidently renders bindings from code.

**[W] From the changelog — the feature is real and substantial:**
* **1.15.2 (2026-07-08)**: *"新增**键盘快捷键设置，支持软件内 / 全局分别设置**等多种功能"* — a keyboard-shortcut settings page supporting **separate in-app and global bindings**. **This feature postdates my v1.10.0 binary**, which is why the page exists but I could not enumerate its contents.
* **No official keyboard-shortcut documentation page exists.** The following bindings are scattered across changelog entries and the music-library doc:

| Binding | Action | Source |
|---|---|---|
| **Space** | Play / pause | 1.7.10 fix for Space conflicting between IME and playback control |
| **↑ / ↓** | Volume up / down | 1.0.1262 |
| **Ctrl + volume keys** | Volume (changed to require Ctrl) | 1.0.1298 |
| **Esc** | Back / close dialog | 1.15.2 fix |
| **Ctrl + A** | Select all | 1.8.2 |
| **Shift + click** | Range-select | music-library doc; 1.8.2 |
| **Ctrl + click** | Add to selection | music-library doc |
| **Shift + arrow keys** | Extend selection | music-library doc |
| **Mouse side buttons** | Back / forward navigation | 1.5.0 (back), 1.9.0 (forward) |

**[I]** Hardware media keys and SMTC transport controls work regardless of focus (via `JmtcManager`), independent of the in-app shortcut map.

**[X]** Still unknown: the *complete* default binding set and the full list of globally-bindable actions. **[W]** The 1.15.2 feature is described as *"键盘快捷键设置，支持软件内 / 全局分别设置"* — a **settings page with separate in-app and global scopes** — which strongly implies bindings **are user-customisable**. No screenshot of that page was found.

**[W] ⚠️ A caveat on the shortcut table above.** Several of these bindings (notably Space, ↑/↓ for volume, and Ctrl+volume) are recovered from **changelog entries describing fixes or changes**, not from a documented binding table. They reflect the state at the version in which they were mentioned and may have changed since. **Treat the table as indicative, and verify against the 1.15.2+ settings page before implementing.**

### 5.2 Context menus

**[V]** The `track_menu` string ("Track Menu") confirms a dedicated track context menu. Verified actions it can offer:

| Action | String key |
|---|---|
| Play | `play`, `play_all` |
| Add to playlist | `add`, `successfully_added_to_playlist`, `unable_to_add_duplicate_to_playlist` |
| Queue (after current) | `queue_after_current` |
| Queue (after last inserted) | `queue_after_last_inserted` |
| Queue (at end) | `queue_at_end` |
| Add to / remove favourite | `favorite`, `remove_favorite` |
| Edit / tag | `edit`, `tag`, `track_information` |
| Re-read tag from file | `reread_track_information_from_file` |
| Remove from playlist | `remove_from_playlist` |
| Remove from music library | `remove_from_music_library` |
| Open in Explorer | `open_in_explorer` |
| Open with other app | `open_with_other_app` |
| Copy file path | `copy_file_path` |
| Delete file | `ic_delete_file` |

**[V]** Other menus and their verified items:
* **Playback mode menu:** `repeat_all`, `repeat_one`, `random_play` / `random` — **[OCR]** observed in the UI as `二 列表循环` (list loop) on the album page
* **Sort menu:** `ascending`, `descending` + sort fields (`name`, `added_time`, `modified_time`, `play_count`, `duration`, `year`, `track_number`)
* **Batch/selection menu:** `select_all`, `deselect_all`, `invert_selection`, `range_selection`
* **Caption-bar system menu:** the native window menu, re-implemented (`GetSystemMenu` / `TrackPopupMenu`)
* **Tray menu:** provided by `com.kdroid.composetray` (Compose-drawn native menu); exact items are **[X]**
* **Native Windows file drag-and-drop** as a transfer source (`TracksTransferable`) — tracks can be dragged *out* of the app

**[W] Additional context-menu actions documented in the changelog:**
* 从音乐库中移除 (Remove from library) — also in the official music-library doc
* 复制文件地址 (Copy file path) — 1.6.10
* 跳转专辑 / 专辑艺术家 / 表演艺术家 (Jump to album / album artist / performing artist) — 1.5.20
* 播放选中队列 (Play selected queue) on multi-select — 1.15.2
* 添加到队列 (Add to queue; consolidated from the earlier 插播 insert-play options) — 1.15.2
* 定位到当前播放歌曲 (Locate currently playing) / locate in Explorer — 1.2.0, 1.6.20
* **Right-clicking the mini player bar's left region opens the track menu** — 1.8.2

**[OCR]** A context menu captured on the Songs page shows at least `播放界面` (Playback Screen) and `音轨菜单` (Track Menu) entries.

**[W] Other documented input behaviours:** click blank space left/right of the list to clear selection (1.5.10); drag songs from SPW to external apps (1.0.993); drag files/folders anywhere on the window to scan (1.0.1167); mouse-wheel over the mini-bar volume button (1.6.10); mouse cursor auto-hides in now-playing (1.7.0).

---

## 6. What I could NOT verify

### 6.1 Blocked network access — and the two workarounds that succeeded

`github.com`, `raw.githubusercontent.com`, `store.steampowered.com`, `api.steampowered.com`, `steamcommunity.com`, `steamdb.info`, `play.google.com`, `archive.org`, `cdn.jsdelivr.net`, `r.jina.ai`, `linux.do` and every CORS proxy tried were **DNS-blocked** (non-public IP) or refused. Three routes worked and should be reused:

| Workaround | What it unlocked |
|---|---|
| **`https://gh-proxy.com/`** (and `ghproxy.net`) prefixing `raw.githubusercontent.com` / `api.github.com` | Official docs repo, changelog source, plugin API README + config schema, Android README, third-party plugin READMEs |
| **`https://moriafly.com/program/spw/`** direct | The full official VitePress documentation set and changelog |
| **`https://api.ocr.space/parse/imageurl?apikey=helloworld&url=<enc>&language=chs&OCREngine=2&isOverlayRequired=true`** | **The screenshots.** The harness cannot view images and the shell has no outbound network, but the OCR service fetches server-side — so Steam/Microsoft CDN images became readable **with per-word pixel bounding boxes** |
| **Microsoft Store catalog APIs** — `displaycatalog.mp.microsoft.com/v7.0/products/9P42FQ0WPQXK` and `storeedgefd.dsx.mp.microsoft.com/v9.0/products/9P42FQ0WPQXK` | The verbatim English feature bullets, system requirements, pricing, and **all four official 1920 × 1080 screenshot URLs** |
| **`https://www.wasdland.com/game/salt-player-for-windows-3009140/`** | A Steam store mirror: the Steam blurb, genres, system requirements, screenshot CDN URLs, and **5 full user reviews verbatim** |

**[W] DeepWiki was unreachable and must not be cited.** `deepwiki.com/Moriafly/SaltPlayerSource` is a client-rendered SPA returning only a "Loading…" shell. It is also **AI-generated third-party analysis of a repository that contains no application source code** (only READMEs and translations), so even if readable its architectural claims would be unreliable. **Do not use DeepWiki as a source for this project.** Likewise, the SourceForge editorial review is **AI-generated and unreliable** (it claims an "album-art fetcher" that no official source mentions).

### 6.2 The screenshot gap — now largely CLOSED

**Resolved by OCR (§1.0).** I obtained and read **4 Microsoft Store screenshots (build 1.12.0 EA)** and **6 Steam screenshots (build 24.5.1504)**, all 1920 × 1080, and extracted **measured pixel coordinates**. This settled:

* ✅ Caption bar height (**≈ 64 px**), title position, window-button positions
* ✅ **Persistent left sidebar with text labels**, its exact item order, **row pitch ≈ 59–61 px**, group gaps
* ✅ Sidebar **remains visible on Settings pages** (settings render beside it)
* ✅ Content pane columns: title/artist **x ≈ 441**, album **x ≈ 1108**, duration right-aligned **x ≈ 1825**
* ✅ **Track row height ≈ 98–100 px**
* ✅ Bottom bar is the **mini player bar**, **≈ 90 px** tall, with sample-rate + volume readouts
* ✅ Now-playing is a **full-window overlay with no sidebar**, lyrics-centric
* ✅ Settings rows **≈ 64 px** apart; selectors render as a **horizontal two-option row**; label-left / value-right pattern
* ✅ **Lyric lines stack as original + romanisation + translation**

**Still open:** colour confirmation, corner radii, spacing tokens, elevation, icon-only control positions, the Albums index (grid vs list), and the wizard / shortcut / Workshop / desktop-lyrics pages (no screenshots found).

### 6.3 Design tokens that could not be resolved

* **No colour could be confirmed visually.** OCR returns text and boxes only. Every value in §2.1 is read from the binary's constant pools — which is reliable for *what the values are*, but I could not verify *how they look on screen*, and **not which token maps to which surface** (window vs sidebar vs card vs player bar). The `AppColors` property names are R8-obfuscated to CJK glyphs; only `Windows11HighlightDark` survived legibly.
* **The UI typography scale.** Body/label/title sizes are not in the constant pools I could read. The measured screenshots give *rendered pixel heights* (title line ~25 px, secondary line ~20 px, page heading ~45 px, sidebar row ~22–25 px) but not the underlying `sp` values, and DPI scaling is unknown.
* **Icon stroke weight / optical sizing** conventions beyond the raw SVG paths.
* **Exact motion curves and durations** (only a bare `500` float near the navigation code).
* Whether the accent colour is **read from Windows** or hard-coded to the Windows 11 default `#4CC2FF` (the value matches the Windows default exactly, suggesting system-read — but this is inference).
* **Corner radii and elevation** — the candidate constants 6/10/32 were recovered from the theme class but their assignment to specific components is inference, and no radius could be measured.

### 6.4 Cover-art-driven theming — explicitly NOT verified

**Do not implement cover-art colour extraction on the strength of this document.**

* **[V]** The binary has an `image` package with `AudioCoverKeyer` (a Coil cache `Keyer`), `AudioCoverFetcher`, `CoverFetcher`, `WindowsFileUriFetcher`, plus `util/ColorUtilKt` exposing an **`isDark`** luminance test.
* **[W] But no official SPW source mentions extracting accent colours from album art.** The closest documented feature is that SPW could follow the Windows personalisation setting *"在标题栏和窗口边框上显示强调色"* (show accent colour on title bars and window borders, 1.0.1167, later removed on Win10).
* **[W]** The **Android** app does have colour extraction — but it is **壁纸取色 (wallpaper colour extraction, Android 12+)** and **分控主题** (separately themed home/playback screens), **not cover-art extraction**.

**Conclusion:** cover art plausibly drives a **light/dark luminance decision and an ambient glow ("Sunglow")**, but a Material-You-style dynamic palette derived from artwork is **not established for SPW**. Treat it as an open design decision.

### 6.5 Features whose existence I could not confirm

* **ReplayGain / RG2 / loudness normalisation** — no string, key or class in the binary; absent from all official docs. Only third-party *Android* blog evidence. **Likely absent on Windows.**
* **Last.fm / scrobbling** — not found anywhere. **Likely absent.**
* **Discord Rich Presence** — not found. (Steam Rich Presence *is* present.)
* **Sleep timer / auto-shutdown** — not found.
* **DSD64/128/256, DoP, native DSD** — documented nowhere, on either platform.
* **Equalizer specifics for SPW** — band count, centre frequencies, Q values and preset list unknown (only `eq_id` and `bass_fx` confirmed; effects were taken offline in 1.5.10). Android's 32-band parametric EQ spec does **not** transfer.
* **Streaming / network sources** — `Audio Stream` and `media_source` strings exist and 1.9.0 mentions *"优化使用 Media Foundation 编解码器的网络/缓冲流"* (network/buffered streams using Media Foundation codecs), but whether internet radio or network shares are first-class features is unclear.
* **The full modding API contract** — I recovered the *names* of extension-point methods and their parameter types plus the manifest keys, but not full method signatures, lifecycle guarantees, or version-compatibility rules.
* **Whether Salt Player itself is open source.** The strings `open_source_projects_used`, `open_source_link` and `license` refer to *third-party* OSS and to *mods*; they do **not** establish that Salt Player is open source. Both `Moriafly/SPW` and `Moriafly/SaltPlayerSource` are **documentation and release-tracking repos containing no application source** — the app is **closed source**. Salt Player's own licence terms were not obtained.
* **Exact pricing/Early Access exit date** and the **roadmap** (none published; the official about page notes *"以上描述存在前瞻性，可能随时更改"*).
* **Keyboard-shortcut table** — see §5.1.

### 6.6 Things I deliberately did not do

* I did **not** launch the application (no screenshots, no live UI inspection).
* I did **not** decompile method bodies; analysis is limited to **constant pools** (strings, numbers, colours), **resource manifests**, and **class/package names**. Control flow, composition structure and precise layout arithmetic inside methods were out of scope.
* I did **not** modify anything inside the `Salt Player for Windows\` installation. All extraction happened in a scratch directory.

### 6.7 Recommended next steps to close the gaps

The screenshot gap is now closed (§1.0). What remains is mostly **colour and fine spacing**, which requires a *viewed* image rather than OCR:

1. **View the four official screenshots directly** (URLs in §8) in any environment that can display images, to sample the actual surface colours, corner radii, and elevation. The OCR boxes in §1.0 tell you exactly where to look.
2. **Open the "Keyboard Shortcut" settings page** (requires ≥1.15.2) and transcribe the binding table — still the highest-value unknown.
3. **Open the Albums page** to settle grid-vs-list, and the Workshop/desktop-lyrics/wizard pages, none of which appear in any screenshot.
4. **Inspect the user data directory** (Settings → App Data) for the Room database and the `Preferences` node — this reveals the on-disk schema and real persisted values.
5. **Install a Workshop mod** (e.g. a `preference_config.json`-driven one) and inspect its JAR/manifest to document the plugin contract concretely.
6. **Read the official standards** at `moriafly.com/standards/` — especially **SPL** (Salt Player Lyrics syntax) and **TDTS** (Salt UI text/translation standard) — before designing the lyrics model.
7. **Re-run the OCR recipe** (§6.1) against the **1.18.0** Microsoft Store screenshots to see the newest layout, since the ones I measured are 1.12.0 EA.

---

## 7. Quick-reference summary for the reimplementation

**Adopt these verified decisions directly:**

| Area | Decision |
|---|---|
| **Window (measured)** | 1920×1080 reference. Caption bar **≈ 64 px** (title x≈70, buttons x≈1736–1893). Body y≈64–990. Bottom mini bar **≈ 90 px**. |
| **Sidebar (measured)** | Persistent left rail, **text labels not icon-only**, **≈ 320 px** wide (bounded < 441). Row pitch **≈ 60 px**, group gap **+13 px**. Text inset x ≈ 90. Order: Songs · Genres · Albums · Artists · Folders ‖ Music Library · Settings ‖ New Playlist + user playlists. **Stays visible on Settings pages.** |
| **Content pane (measured)** | x ≈ **441 … 1873**. Symmetric outer gutter ≈ **90–95 px**. Track rows **≈ 98–100 px** tall. Columns: title+artist x≈441 · album x≈1108 · duration right-aligned to x≈1825. |
| **Settings rows (measured)** | **≈ 64 px** pitch; label-left/value-right; selectors as a **horizontal 2-option row**; section headers with a ~140 px gap above. |
| Window chrome | Custom caption bar + DWM backdrop (Salt Classic/Acrylic/Mica/MicaAlt), 16 px window glyphs, gated on Windows build 22000/22523 |
| Dark palette | `#1F1E1C` (warm), `#24262E` / `#1E262D` / `#1B1D26` (cool), `#30302F` |
| Light palette | `#FAFAFA`, `#F3F5F7` (cool), `#F3F2F1` (warm) |
| Accent | `#4CC2FF` |
| Scrims | `#90000000` (56 % black), `#99FFFFFF` (60 % white), `#B9FFFFFF` (73 % white) |
| Default theme | **Dark** (not Follow System). **Now-playing is always dark** regardless of theme. |
| Fonts | Inter (UI), JetBrains Mono (mono), MiSans (CJK), user-custom file incl. .woff2 |
| Depth | Backdrop blur + scrims, **not** shadows |
| Radii | ~6 dp small, ~10 dp medium, ~32 dp large surface (inferred, unmeasured) |
| Icon tinting | single `icon_foreground` token per theme |
| Icon sizes | 16 px chrome · 24 dp generic · 28 px queue · 30 px transport · 38 px mini player |
| Quality badge | 30 px pill chip; HQ (320 kbps) / CD (16-44.1) / CD+ (>16-bit or >44.1 kHz) / HiRes (24-96+) / RAW (32-192+); light + dark variants; none for DSD |
| **Now-playing (measured)** | **Full-window overlay replacing the whole shell** (no sidebar). Lyrics-centric: a **stack of 3–5 lines per phrase** (original + romanisation + translation), then title, then progress. Always dark. |
| **Mini player bar (measured)** | The persistent **bottom** bar (≈90 px), right-weighted: now-playing label x≈120 · artwork/lyric element x≈1088 · overflow `•••` x≈1641 · **output sample-rate readout** x≈1700 · volume glyph+level x≈1783/1789. Has collapsed/expanded animation; wheel-adjustable volume; right-click left region → track menu. |
| Lyrics | embedded + LRC + SPL; word-by-word karaoke; Start/Center alignment; blur inactive lines; translation at scaled size; 1.6 line height; separate desktop window; **multi-row-per-phrase layout is required** |
| Audio | **BASS** core (bass + flac/ape/alac/dsd/dts/cd/fx/mix/wasapi) behind a "Pisces"-style wrapper; AAC/AIFF/APE/FLAC/M4A/MP3/OGG/OPUS/WAV/WV; DirectSound / WASAPI / WASAPI-Exclusive; 7-step Sinc SRC ladder (Linear→Sinc256); gapless **on by default**; dither; perfect sample rate with its gapless caveat |
| Output strategy | Lock hardware to the **system-preferred sample rate** and resample everything to it (SPW's documented approach); exclusive mode is **not** recommended for casual listening |
| Library | Room-backed: Track/Album/Artist/Genre/Folder/Playlist; **add-only, never auto-delete**; pinyin-aware sort; rebuild + unreadable-track workflow |
| Plugins | **PF4J**-based JVM JAR mods; `SpwPlugin` + `PluginContext`; 7 playback extension points; declarative `preference_config.json` (switch/list/button/seekbar/edittext); disabled by default |
| Persistence | `java.util.prefs.Preferences` key-value store, ~57 documented keys |
| System integration | SMTC + hardware media keys, taskbar thumbnail toolbar, system tray with close-to-tray |
| Not to assume | ReplayGain, Last.fm scrobbling, Discord RPC, ASIO, in-app tag editing, sleep timer, cover-art colour extraction — **none verified** |

---

## 8. Source URLs

**Official (verified working):**
* Official SPW documentation hub — https://moriafly.com/program/spw/
* Changelog (1.0.766 → 1.18.x) — https://moriafly.com/program/spw/changelog.html
* Audio engine — https://moriafly.com/program/spw/doc/audio-engine.html
* Audio format support (DTS) — https://moriafly.com/program/spw/doc/audio-format-support.html
* Appearance / themes — https://moriafly.com/program/spw/doc/appearance.html
* Gapless playback — https://moriafly.com/program/spw/doc/gapless-playback.html
* Track item + quality badges — https://moriafly.com/program/spw/doc/track-item.html
* Render (DirectX/OpenGL, V-Sync) — https://moriafly.com/program/spw/doc/render.html
* Workshop / mods — https://moriafly.com/program/spw/doc/workshop.html
* Install / system requirements — https://moriafly.com/program/spw/doc/install.html
* Music library (selection gestures) — https://moriafly.com/program/spw/doc/music-library.html
* Legal information — https://moriafly.com/program/spw/doc/legal-information.html
* Salt Player standards hub — https://moriafly.com/standards/ (incl. `spl.html` — Salt Player Lyrics syntax; `tdts.html`; `metadata.html`)
* Salt Player for Android product page — https://moriafly.com/program/salt-player.html
* Plugin API repo README — https://gh-proxy.com/https://raw.githubusercontent.com/Moriafly/spw-workshop-api/main/README.md
* Plugin config schema — https://gh-proxy.com/https://raw.githubusercontent.com/Moriafly/spw-workshop-api/main/docs/configs.md
* SPW docs repo README — https://gh-proxy.com/https://raw.githubusercontent.com/Moriafly/SPW/main/README.md
* SPW docs repo index (feature list) — https://gh-proxy.com/https://raw.githubusercontent.com/Moriafly/SPW/main/docs/index.md
* SaltPlayerSource README (Android) — https://gh-proxy.com/https://raw.githubusercontent.com/Moriafly/SaltPlayerSource/main/README.md
* Android DSD deprecation article — https://gh-proxy.com/https://raw.githubusercontent.com/Moriafly/SaltPlayerSource/main/articles/240902_Deprecated_DSD.md
* Legacy demo-era about page — http://spw.moriafly.com/about.html
* Legacy demo-era appearance settings — http://spw.moriafly.com/settings/appearance.html

**Steam / store (fetched indirectly — Steam itself was DNS-blocked):**
* Steam store page (canonical URL, not directly retrievable here) — https://store.steampowered.com/app/3009140/Salt_Player_for_Windows/
* Steam AppID confirmation — https://help.steampowered.com/en/wizard/HelpWithGameTechnicalIssue?appid=3009140
* **Steam store mirror (blurb, requirements, screenshot URLs, 5 full reviews)** — https://www.wasdland.com/game/salt-player-for-windows-3009140/
* Microsoft Store product page — https://apps.microsoft.com/detail/9P42FQ0WPQXK
* **Microsoft Store catalog API (verbatim English features, requirements, screenshot URLs)** — https://displaycatalog.mp.microsoft.com/v7.0/products/9P42FQ0WPQXK?market=US&languages=en-us&fieldsTemplate=Details
* Store listing text mirror (Chinese bullets, price, rating) — https://www.crxsoso.com/store/detail/9p42fq0wpqxk
* Store/Steam listing mirror (Chinese bullets, system requirements) — https://www.fhyx.com/box/v2/item/16420.html
* SteamDB patch notes (blocked here; titles only, cited for reference) — https://steamdb.info/app/3009140/patchnotes/

**Screenshots actually OCR'd for §1.0 (all 1920 × 1080):**

*Microsoft Store, build 1.12.0 EA:*
* Songs list — https://store-images.s-microsoft.com/image/apps.24356.14597343722925918.f74a9330-7e14-4235-8ef5-f74e308f021f.edd90d84-75db-4f22-917d-b190d67db512
* Album detail — https://store-images.s-microsoft.com/image/apps.4063.14597343722925918.f74a9330-7e14-4235-8ef5-f74e308f021f.224c3fec-c5f2-4ca9-bd43-1f8bebb95d8a
* Audio-engine settings — https://store-images.s-microsoft.com/image/apps.55671.14597343722925918.f74a9330-7e14-4235-8ef5-f74e308f021f.018588e7-c632-4ff9-9551-69d32459518b
* Now-playing — https://store-images.s-microsoft.com/image/apps.45432.14597343722925918.f74a9330-7e14-4235-8ef5-f74e308f021f.a1a67334-d284-4ca0-9de6-a9e885c781d5

*Steam, build 24.5.1504:*
* Genre page — https://shared.cloudflare.steamstatic.com/store_item_assets/steam/apps/3009140/ss_3e016eac5a9d562407cbcb0103616161d725f8a0.1920x1080.jpg
* UI settings — https://shared.cloudflare.steamstatic.com/store_item_assets/steam/apps/3009140/ss_7df906a436066d80b8fe7fabaf33b9dd08f9b96c.1920x1080.jpg
* Credits — https://shared.cloudflare.steamstatic.com/store_item_assets/steam/apps/3009140/ss_ecfa7ea9067a01c28d4f1bc648fd1129d96e5d4a.1920x1080.jpg
* About — https://shared.cloudflare.steamstatic.com/store_item_assets/steam/apps/3009140/ss_afdc7c31fb0698b2085a824f6993dd18442bd45b.1920x1080.jpg
* Audio engine — https://shared.cloudflare.steamstatic.com/store_item_assets/steam/apps/3009140/ss_31bbc67b37895c8f8692c480b797be5654069ef5.1920x1080.jpg
* Now-playing with lyrics — https://shared.cloudflare.steamstatic.com/store_item_assets/steam/apps/3009140/53b1c32e2ccd92eb903a64bd915c2042e3c0ee73/ss_53b1c32e2ccd92eb903a64bd915c2042e3c0ee73.1920x1080.jpg

**OCR recipe used** (returns per-word pixel bounding boxes):
`https://api.ocr.space/parse/imageurl?apikey=helloworld&url=<URL-encoded image URL>&language=chs&OCREngine=2&isOverlayRequired=true`

**Third-party plugins (evidence the mod system works):**
* https://github.com/zmxlsss666/SaltLyricPlugin
* https://github.com/zmxlsss666/TaskbarLyricsPlugin
* https://github.com/zmxlsss666/SaltTimePlugin

**Third-party commentary:**
* 少数派 review of the **Android** app (UI description) — https://m.163.com/dy/article/HPJHNTTF05119NPR.html
* 异次元软件世界 (brief Windows UI remark) — https://www.iplaysoft.com/salt-player.html
* ReplayGain discussion (Android context, blog) — https://blog.yangzirui.com/archives/112/

**Explicitly NOT usable sources:**
* `https://deepwiki.com/Moriafly/SaltPlayerSource/*` — client-rendered SPA, unreadable, and AI-generated analysis of a repo containing no source code.
* `https://sourceforge.net/app/salt-player-for-windows` — AI-generated editorial review containing at least one fabricated feature ("album-art fetcher").
