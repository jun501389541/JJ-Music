export type DlnaFailureCode='stop-unconfirmed'|'network-changed'|'offline'|'timeout'|'permission'|'unsupported'|'unknown'
const messages:Record<DlnaFailureCode,string>={
  'stop-unconfirmed':'无法确认设备已经停止，设备可能仍在播放。请先确认设备停止，再决定是否返回本机。',
  'network-changed':'网络或网卡已变化，请断开投放后重新选择网卡和设备。',
  offline:'无法连接设备。请确认设备在线，电脑与设备连接同一私有网络，然后重试。',
  timeout:'设备响应超时。请检查网络和设备状态；若被防火墙阻止，可检查应用的私有网络访问权限后重试。',
  permission:'网络访问被拒绝。请检查应用的私有网络防火墙权限；应用不会自动修改防火墙设置。',
  unsupported:'设备能力或媒体格式不受支持。请使用渐进 MP3，并确认设备支持所选控制操作。',
  unknown:'投放操作失败。请检查设备与网络状态后重试；不会自动切回本机播放。'
}
/** Fixed presentation only: raw endpoints, media tokens and paths never escape. */
export function dlnaFailure(error:unknown):{code:DlnaFailureCode;message:string;requiresStopConfirmation:boolean}{
  const text=error instanceof Error?error.message:typeof error==='string'?error:''
  let code:DlnaFailureCode='unknown'
  if(text.includes('stop-unconfirmed'))code='stop-unconfirmed'
  else if(/interface (changed|unavailable)|网卡|网络.*变化/i.test(text))code='network-changed'
  else if(/ETIMEDOUT|timeout|timed out|超时/i.test(text))code='timeout'
  else if(/EACCES|EPERM|permission|access denied/i.test(text))code='permission'
  else if(/ECONNREFUSED|EHOSTUNREACH|ENETUNREACH|device expired|device offline/i.test(text))code='offline'
  else if(/unsupported|not support|requires progressive|不支持/i.test(text))code='unsupported'
  return {code,message:messages[code],requiresStopConfirmation:code==='stop-unconfirmed'}
}
