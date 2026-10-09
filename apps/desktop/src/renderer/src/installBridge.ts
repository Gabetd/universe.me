import { installWebBridge } from './webBridge'

// In the phone's browser there's no Electron preload: the computer is asked over the web instead.
// Imported first, so the bridge is there before any other module looks for it.
if (!('universe' in window)) installWebBridge()
