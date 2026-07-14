export { captureWechatWindow, takeWeChatScreenshot, calculateRedDotPercentage, captureChatMainArea } from './screenshot-utils'
export type { AppType } from './types'
export { getWindowInfo, getWechatWindowInfo } from './window-utils'
export { sendReplyAction, activeUnreadByClickAction, clickUnreadContactAction } from './input-utils'
export { compareImages, hasImageChanged, setChatBaseline, clearChatBaseline, hasChatBaseline, checkChatAreaDiff } from './image-compare'
export { hasUnreadMessage, isChatContactUnread } from './has-unread'
export { detectUnreadArea, getUnreadAreaWithCache } from './unread-detection'
export { detectWechatLayout } from './layout-detection'
export {
  parseBBoxes, parsePoint,
  bboxToScreenCoords, pointToScreenCoords, bboxToCropBounds,
  getLayoutCache, setLayoutCache, clearLayoutCache,
  type BBox, type LayoutCache
} from './vision-utils'
