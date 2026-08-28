async function openEditor(tab) {
  if (!tab?.id || !tab.url || !/^https?:\/\//.test(tab.url)) return
  try {
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] })
    await chrome.tabs.sendMessage(tab.id, { type: 'INTERACTIVE_HTML_EDITOR_TOGGLE' })
  } catch (error) {
    console.warn('HTML editor could not open on this page.', error)
  }
}

chrome.action.onClicked.addListener(openEditor)
chrome.commands.onCommand.addListener(async command => {
  if (command !== 'toggle-editor') return
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
  await openEditor(tab)
})
