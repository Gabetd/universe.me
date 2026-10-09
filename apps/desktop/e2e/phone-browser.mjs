// A stand-in phone for the phone app's e2e test: Chromium (Electron's own, so nothing is downloaded)
// showing one page at a phone's size, with its own cookies, as the phone's browser would.
import { app, BrowserWindow } from 'electron'

app.commandLine.appendSwitch('no-sandbox')
app.whenReady().then(() => {
  const win = new BrowserWindow({ width: 390, height: 844, webPreferences: { partition: 'phone', sandbox: true, contextIsolation: true, backgroundThrottling: false } })
  void win.loadURL(process.env.PHONE_URL)
})
