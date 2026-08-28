(() => {
  if (window.__INTERACTIVE_HTML_EDITOR__) return

  const EXTENSION_UI = 'data-html-editor-ui'
  const schema = 'interactive-html-edit/v1'
  const anchors = {
    '左上': [0, 0], '上中': [.5, 0], '右上': [1, 0],
    '左中': [0, .5], '中心': [.5, .5], '右中': [1, .5],
    '左下': [0, 1], '下中': [.5, 1], '右下': [1, 1],
  }
  const state = {
    open: false,
    selecting: false,
    selected: null,
    hover: null,
    anchor: '右上',
    textDraft: '',
    imageDraft: { width: '100%', height: 'auto', fit: 'cover', positionX: 50, positionY: 50 },
    noteDraft: '',
    status: '改动自动保存在扩展本地，不进入网站代码',
    gridSize: 8,
    drag: null,
    suppressClick: false,
    history: [],
    saveQueue: Promise.resolve(),
    document: { schema, page: '', changes: [], annotations: [], creations: [] },
    activePage: '',
  }

  const host = document.createElement('div')
  host.setAttribute(EXTENSION_UI, '')
  host.style.cssText = 'all:initial;position:fixed;inset:0;z-index:2147483647;pointer-events:none'
  const shadow = host.attachShadow({ mode: 'open' })
  const css = document.createElement('link')
  css.rel = 'stylesheet'
  css.href = chrome.runtime.getURL('editor.css')
  shadow.append(css)
  const textEditorCss = document.createElement('link')
  textEditorCss.rel = 'stylesheet'
  textEditorCss.href = chrome.runtime.getURL('text-editor.css')
  shadow.append(textEditorCss)
  const root = document.createElement('div')
  root.className = 'ihe-root'
  shadow.append(root)

  const pageKey = () => `${location.origin}${location.pathname}${location.search}`
  const storageKey = () => `html-editor::${pageKey()}`
  const uid = prefix => `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`
  const escapeCss = value => CSS.escape(value)
  const textOf = element => (element.innerText || element.getAttribute('aria-label') || '').trim().replace(/\s+/g, ' ').slice(0, 140)

  function contextOf(element) {
    const heading = element.closest('section,article,main,div')?.querySelector('h1,h2,h3,h4')
    return {
      tag: element.tagName.toLowerCase(),
      role: element.getAttribute('role'),
      ariaLabel: element.getAttribute('aria-label'),
      text: textOf(element),
      nearestHeading: heading && heading !== element ? textOf(heading) : null,
    }
  }

  function stableSelector(element) {
    if (element.id) return `#${escapeCss(element.id)}`
    const editorNode = element.getAttribute('data-html-editor-node')
    if (editorNode) return `[data-html-editor-node="${CSS.escape(editorNode)}"]`
    for (const attr of ['data-testid', 'data-test', 'data-cy']) {
      const value = element.getAttribute(attr)
      if (value) return `[${attr}="${CSS.escape(value)}"]`
    }
    const parts = []
    let node = element
    while (node && node !== document.body && parts.length < 7) {
      let part = node.tagName.toLowerCase()
      const usefulClass = [...node.classList].find(name => !/^(active|selected|hover|focus|css-|sc-)/.test(name) && name.length < 48)
      if (usefulClass) part += `.${escapeCss(usefulClass)}`
      const parent = node.parentElement
      if (parent) {
        const sameTags = [...parent.children].filter(child => child.tagName === node.tagName)
        if (sameTags.length > 1) part += `:nth-of-type(${sameTags.indexOf(node) + 1})`
      }
      parts.unshift(part)
      const selector = parts.join(' > ')
      try { if (document.querySelectorAll(selector).length === 1) return selector } catch {}
      node = parent
    }
    return `body > ${parts.join(' > ')}`
  }

  function find(selector) {
    try { return document.querySelector(selector) } catch { return null }
  }

  function emptyDocument() {
    return { schema, page: pageKey(), changes: [], annotations: [], creations: [] }
  }

  function removeCreatedNodes() {
    document.querySelectorAll('[data-html-editor-node]').forEach(element => element.remove())
  }

  function applyCreation(creation) {
    let element = find(creation.selector)
    if (!element) {
      element = document.createElement(creation.tag || 'div')
      element.setAttribute('data-html-editor-node', creation.id)
      document.body.append(element)
    }
    if (element.textContent !== creation.text) element.textContent = creation.text
    Object.entries(creation.styles || {}).forEach(([property, value]) => { element.style[property] = value })
    return element
  }

  function applyCreations() {
    state.document.creations?.forEach(applyCreation)
  }

  function originalOf(element) {
    const priorityOf = property => element.style.getPropertyPriority(property)
    return {
      width: element.style.width,
      height: element.style.height,
      maxWidth: element.style.maxWidth,
      maxHeight: element.style.maxHeight,
      zIndex: element.style.zIndex,
      borderRadius: element.style.borderRadius,
      display: element.style.display,
      translate: element.style.translate,
      objectFit: element.style.objectFit,
      objectPosition: element.style.objectPosition,
      backgroundImage: element.style.backgroundImage,
      backgroundSize: element.style.backgroundSize,
      backgroundPosition: element.style.backgroundPosition,
      backgroundRepeat: element.style.backgroundRepeat,
      src: element instanceof HTMLImageElement ? element.src : null,
      priorities: {
        width: priorityOf('width'), height: priorityOf('height'),
        maxWidth: priorityOf('max-width'), maxHeight: priorityOf('max-height'),
        objectFit: priorityOf('object-fit'), objectPosition: priorityOf('object-position'),
        backgroundSize: priorityOf('background-size'), backgroundPosition: priorityOf('background-position'),
        backgroundRepeat: priorityOf('background-repeat'),
      },
    }
  }

  function applyChange(change) {
    const element = find(change.selector)
    if (!element) return
    if (change.text && element.textContent !== change.text.value) element.textContent = change.text.value
    Object.entries(change.styles || {}).forEach(([property, value]) => { element.style[property] = value })
    if (change.image?.value && change.image.mode === 'img' && element instanceof HTMLImageElement) element.src = change.image.value
    if (change.image?.value && change.image.mode === 'background') element.style.backgroundImage = `url("${change.image.value}")`
    if (change.image?.display) applyImageDisplay(element, change.image.mode, change.image.display)
  }

  function restoreChange(change) {
    const element = find(change.selector)
    if (!element) return
    if (change.text) element.innerHTML = change.text.originalHTML
    for (const property of ['width', 'height', 'maxWidth', 'maxHeight', 'zIndex', 'borderRadius', 'display', 'translate', 'objectFit', 'objectPosition', 'backgroundImage', 'backgroundSize', 'backgroundPosition', 'backgroundRepeat']) {
      const cssProperty = property.replace(/[A-Z]/g, letter => `-${letter.toLowerCase()}`)
      const originalValue = change.original[property]
      if (originalValue) element.style.setProperty(cssProperty, originalValue, change.original.priorities?.[property] || '')
      else element.style.removeProperty(cssProperty)
    }
    if (element instanceof HTMLImageElement && change.original.src) element.src = change.original.src
  }

  async function load() {
    removeCreatedNodes()
    const key = storageKey()
    const result = await chrome.storage.local.get(key)
    const saved = result[key]
    state.document = saved?.schema === schema
      ? saved
      : emptyDocument()
    state.document.changes ||= []
    state.document.annotations ||= []
    state.document.creations ||= []
    state.document.page = pageKey()
    state.activePage = pageKey()
    state.history = []
    applyCreations()
    state.document.changes.forEach(applyChange)
    render()
  }

  async function save(message = '已保存到扩展本地存储') {
    const key = storageKey()
    const snapshot = cloneDocument(state.document)
    state.saveQueue = state.saveQueue
      .catch(() => {})
      .then(() => chrome.storage.local.set({ [key]: snapshot }))
    try {
      await state.saveQueue
      setStatus(message)
      updateOverlays()
    } catch (error) {
      setStatus(`保存失败：${error?.message || '本地存储不可用'}`)
    }
  }

  function cloneDocument(documentValue) {
    return JSON.parse(JSON.stringify(documentValue))
  }

  function pushHistory() {
    state.history.push(cloneDocument(state.document))
    if (state.history.length > 12) state.history.shift()
  }

  function undoLast() {
    const previous = state.history.pop()
    if (!previous) return setStatus('当前会话没有可撤销的操作')
    const current = state.document
    state.document = previous
    current.changes.forEach(restoreChange)
    removeCreatedNodes()
    applyCreations()
    state.document.changes.forEach(applyChange)
    state.selected = null
    save('已撤销上一步改动')
    render()
  }

  function getOrCreateChange(element) {
    const selector = stableSelector(element)
    let change = state.document.changes.find(item => item.selector === selector)
    if (!change) {
      change = { id: uid('change'), selector, context: contextOf(element), original: originalOf(element), styles: {}, updatedAt: new Date().toISOString() }
      state.document.changes.push(change)
    }
    return change
  }

  function selectElement(element) {
    const selector = stableSelector(element)
    const existing = state.document.changes.find(item => item.selector === selector)
    state.selected = { element, selector, context: contextOf(element) }
    state.textDraft = existing?.text?.value ?? element.textContent ?? ''
    state.imageDraft = existing?.image?.display ? { ...existing.image.display } : defaultImageDisplay(element)
    document.documentElement.style.cursor = state.selecting ? 'crosshair' : ''
    render()
    updateOverlays()
  }

  function changeStyle(property, value) {
    if (!state.selected) return
    pushHistory()
    const change = getOrCreateChange(state.selected.element)
    change.styles[property] = value
    change.updatedAt = new Date().toISOString()
    applyChange(change)
    save()
    renderRecords()
  }

  function restoreDisplay() {
    if (!state.selected) return
    pushHistory()
    const change = getOrCreateChange(state.selected.element)
    change.styles.display = change.original.display || ''
    change.updatedAt = new Date().toISOString()
    applyChange(change)
    save('元素已恢复显示')
    renderRecords()
  }

  function applyText() {
    if (!state.selected) return
    pushHistory()
    const element = state.selected.element
    const creation = state.document.creations.find(item => item.selector === state.selected.selector)
    if (creation) {
      creation.text = state.textDraft
      element.textContent = state.textDraft
      state.selected.context = contextOf(element)
      save('新增文字框内容已保存')
      render()
      return
    }
    const change = getOrCreateChange(element)
    change.text = {
      value: state.textDraft,
      originalHTML: change.text?.originalHTML ?? element.innerHTML,
    }
    change.updatedAt = new Date().toISOString()
    applyChange(change)
    state.selected.context = contextOf(element)
    save('文字修改已保存，可随时恢复原始内容')
    render()
  }

  function addTextBox() {
    pushHistory()
    const id = uid('textbox')
    const creation = {
      id,
      type: 'text-box',
      tag: 'div',
      selector: `[data-html-editor-node="${id}"]`,
      text: '输入文字内容',
      styles: {
        position: 'absolute',
        left: `${Math.round(scrollX + Math.max(24, (innerWidth - 320) / 2))}px`,
        top: `${Math.round(scrollY + Math.max(80, innerHeight * .28))}px`,
        width: '320px',
        minHeight: '96px',
        padding: '18px',
        zIndex: '1000',
        boxSizing: 'border-box',
        border: '1px dashed #9aa0a6',
        borderRadius: '10px',
        background: '#ffffff',
        color: '#202124',
        fontSize: '16px',
        lineHeight: '1.6',
        whiteSpace: 'pre-wrap',
      },
      createdAt: new Date().toISOString(),
    }
    state.document.creations.push(creation)
    const element = applyCreation(creation)
    selectElement(element)
    save('已添加文字框，可修改文字、尺寸并拖动定位')
    requestAnimationFrame(() => shadow.querySelector('[data-text]')?.focus())
  }

  function parseTranslate(value) {
    if (!value || value === 'none') return { x: 0, y: 0, raw: value || 'none' }
    const parts = value.trim().split(/\s+/)
    return { x: Number.parseFloat(parts[0]) || 0, y: Number.parseFloat(parts[1]) || 0, raw: value }
  }

  function beginDrag(event, target) {
    const selected = state.selected?.element
    const element = selected && (selected === target || selected.contains(target)) ? selected : target
    if (element !== selected) selectElement(element)
    const existing = state.document.changes.find(item => item.selector === stableSelector(element))
    const computedBase = existing?.move?.base || parseTranslate(getComputedStyle(element).translate)
    state.drag = {
      element,
      startX: event.clientX,
      startY: event.clientY,
      originDelta: existing?.move?.delta || { x: 0, y: 0 },
      base: computedBase,
      moved: false,
      historyCaptured: false,
    }
  }

  function moveDrag(event) {
    const drag = state.drag
    if (!drag) return false
    const rawX = event.clientX - drag.startX
    const rawY = event.clientY - drag.startY
    if (!drag.moved && Math.hypot(rawX, rawY) < 3) return false
    drag.moved = true
    if (!drag.historyCaptured) {
      pushHistory()
      drag.historyCaptured = true
    }
    state.suppressClick = true
    event.preventDefault()
    event.stopPropagation()
    const snap = value => Math.round(value / state.gridSize) * state.gridSize
    const delta = { x: drag.originDelta.x + snap(rawX), y: drag.originDelta.y + snap(rawY) }
    const change = getOrCreateChange(drag.element)
    change.move = { delta, grid: state.gridSize, base: drag.base }
    change.styles.translate = `${drag.base.x + delta.x}px ${drag.base.y + delta.y}px`
    change.updatedAt = new Date().toISOString()
    applyChange(change)
    document.documentElement.style.cursor = 'grabbing'
    updateOverlays()
    return true
  }

  function endDrag() {
    const drag = state.drag
    state.drag = null
    document.documentElement.style.cursor = state.selecting ? 'crosshair' : ''
    if (!drag?.moved) return
    const change = state.document.changes.find(item => item.selector === stableSelector(drag.element))
    const delta = change?.move?.delta
    save(delta ? `位置已吸附到 ${state.gridSize}px 网格：X ${delta.x}px，Y ${delta.y}px` : '元素位置已更新')
    render()
    setTimeout(() => { state.suppressClick = false }, 0)
  }

  function replaceImage(file) {
    if (!state.selected || !file) return
    const selected = state.selected.element
    const target = selected instanceof HTMLImageElement ? selected : selected.querySelector('img') || selected
    const reader = new FileReader()
    reader.onload = () => {
      pushHistory()
      const change = getOrCreateChange(target)
      const mode = target instanceof HTMLImageElement ? 'img' : 'background'
      const display = change.image?.display || defaultImageDisplay(target)
      change.image = { mode, value: reader.result, name: file.name, display }
      change.updatedAt = new Date().toISOString()
      state.selected = { element: target, selector: stableSelector(target), context: contextOf(target) }
      state.imageDraft = { ...display }
      applyChange(change)
      save('图片已替换并锁定到所选元素')
      render()
    }
    reader.readAsDataURL(file)
  }

  function defaultImageDisplay(element) {
    const computed = getComputedStyle(element)
    const positionSource = element instanceof HTMLImageElement ? computed.objectPosition : computed.backgroundPosition
    const positionParts = (positionSource || '50% 50%').split(/\s+/)
    const percent = (value, fallback) => value?.includes('%') ? Number.parseFloat(value) : fallback
    return {
      width: element instanceof HTMLImageElement ? (element.style.width || '100%') : '100%',
      height: element instanceof HTMLImageElement ? (element.style.height || 'auto') : '100%',
      fit: element instanceof HTMLImageElement ? (computed.objectFit || 'cover') : (computed.backgroundSize === 'contain' ? 'contain' : 'cover'),
      positionX: percent(positionParts[0], 50),
      positionY: percent(positionParts[1], 50),
    }
  }

  function applyImageDisplay(element, mode, display) {
    const position = `${display.positionX}% ${display.positionY}%`
    if (mode === 'img' && element instanceof HTMLImageElement) {
      element.style.setProperty('width', display.width || '100%', 'important')
      element.style.setProperty('height', display.height || 'auto', 'important')
      element.style.setProperty('max-width', 'none', 'important')
      element.style.setProperty('max-height', 'none', 'important')
      element.style.setProperty('object-fit', display.fit === 'custom' ? 'fill' : display.fit, 'important')
      element.style.setProperty('object-position', position, 'important')
      return
    }
    element.style.setProperty('background-repeat', 'no-repeat', 'important')
    element.style.setProperty('background-position', position, 'important')
    const backgroundSize = display.fit === 'fill'
      ? '100% 100%'
      : display.fit === 'custom'
        ? `${display.width || 'auto'} ${display.height || 'auto'}`
        : display.fit
    element.style.setProperty('background-size', backgroundSize, 'important')
  }

  function applyImageLayout() {
    if (!state.selected) return
    const selected = state.selected.element
    const target = selected instanceof HTMLImageElement ? selected : selected.querySelector('img') || selected
    pushHistory()
    const change = getOrCreateChange(target)
    const mode = target instanceof HTMLImageElement ? 'img' : 'background'
    change.image = {
      ...(change.image || {}),
      mode,
      display: { ...state.imageDraft },
    }
    change.updatedAt = new Date().toISOString()
    state.selected = { element: target, selector: stableSelector(target), context: contextOf(target) }
    applyChange(change)
    save('图片展示尺寸和位置已更新')
    render()
  }

  function addAnnotation() {
    if (!state.selected) return
    const textarea = shadow.querySelector('[data-note]')
    const message = state.noteDraft.trim()
    if (!message) return setStatus('请先填写改动说明')
    pushHistory()
    const element = state.selected.element
    const rect = element.getBoundingClientRect()
    const [x, y] = anchors[state.anchor]
    state.document.annotations.push({
      id: uid('note'), selector: state.selected.selector, context: state.selected.context,
      anchor: state.anchor, relativePosition: { x, y }, message,
      createdRect: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) },
      viewport: { width: innerWidth, height: innerHeight }, createdAt: new Date().toISOString(),
    })
    state.noteDraft = ''
    textarea.value = ''
    save('注释已锁定到元素和相对锚点')
    renderRecords()
  }

  function removeRecord(type, id) {
    pushHistory()
    if (type === 'creation') {
      const creation = state.document.creations.find(item => item.id === id)
      if (creation) find(creation.selector)?.remove()
      state.document.creations = state.document.creations.filter(item => item.id !== id)
      if (creation) {
        state.document.changes = state.document.changes.filter(item => item.selector !== creation.selector)
        state.document.annotations = state.document.annotations.filter(item => item.selector !== creation.selector)
      }
    } else if (type === 'change') {
      const change = state.document.changes.find(item => item.id === id)
      state.document.changes = state.document.changes.filter(item => item.id !== id)
      if (change) restoreChange(change)
    } else state.document.annotations = state.document.annotations.filter(item => item.id !== id)
    save('记录已移除')
    render()
  }

  function resetPage() {
    pushHistory()
    const current = state.document
    state.document = emptyDocument()
    current.changes.forEach(restoreChange)
    removeCreatedNodes()
    state.selected = null
    save('当前页面的改动和注释已清空')
    render()
  }

  function aiPayload({ includeImageData = true } = {}) {
    const changes = state.document.changes.map(change => {
      if (includeImageData || !change.image) return change
      return {
        ...change,
        image: {
          mode: change.image.mode,
          name: change.image.name,
          previewDataOmitted: true,
          instruction: '剪贴板清单已省略图片 Data URL；如需获取预览图数据，请使用扩展下载的完整 JSON。',
        },
      }
    })
    return {
      schema, generatedAt: new Date().toISOString(), page: pageKey(), title: document.title,
      instructions: 'creations 表示需要新增的 HTML 元素；按 selector 定位已有或新增元素；change.text.value 是期望文字；change.move.delta 是相对原位置的网格吸附位移；annotation.relativePosition 是元素内部 0~1 相对坐标。styles 是期望的 CSS 内联覆盖；display:none 表示删减。',
      ...state.document,
      changes,
    }
  }

  function aiPrompt() {
    return `请直接修改当前项目中与下方页面对应的前端源码，并严格按改动清单完成需求。

执行要求：
1. 不要只给修改建议；请实际修改代码，并在完成后运行合适的构建或测试进行验证。
2. page、selector、context 和注释锚点用于定位。selector 只是定位线索，若页面源码结构不同，应结合元素文字、最近标题和需求语义找到正确组件。
3. 优先复用项目已有组件、样式变量和交互模式，避免新增重复组件；确需新增时与现有标准组件样式保持一致。
4. creations 表示需要新增的 HTML 元素；change.text.value 表示目标文字；styles 表示目标样式；change.move.delta 表示相对原位置的 X/Y 位移；display:none 表示需要删减或隐藏；image 表示图片替换或添加需求。
5. annotations 是锁定在目标元素上的产品修改说明，应作为实现意图，而不是把注释标记本身做进页面。
6. 不要把浏览器标注器、运行时内联覆盖或评审数据加入正式网站代码。
7. 保留与清单无关的现有功能和用户改动。若个别要求存在冲突，优先满足具体注释，并在完成说明中指出取舍。

下方是结构化改动清单：`
  }

  async function writeClipboard(text) {
    if (navigator.clipboard?.writeText) {
      try {
        await navigator.clipboard.writeText(text)
        return
      } catch {}
    }
    const textarea = document.createElement('textarea')
    textarea.setAttribute(EXTENSION_UI, '')
    textarea.value = text
    textarea.style.cssText = 'position:fixed;left:-99999px;top:0;width:1px;height:1px;opacity:0;pointer-events:none'
    document.documentElement.append(textarea)
    textarea.focus()
    textarea.select()
    textarea.setSelectionRange(0, textarea.value.length)
    const copied = document.execCommand('copy')
    textarea.remove()
    if (!copied) throw new Error('浏览器拒绝了剪贴板写入')
  }

  async function copyJson() {
    try {
      const text = `${aiPrompt()}\n\n${JSON.stringify(aiPayload({ includeImageData: false }), null, 2)}`
      await writeClipboard(text)
      setStatus('AI 执行提示词和改动清单已复制')
    } catch (error) {
      setStatus(`复制失败：${error?.message || '请检查浏览器剪贴板权限'}`)
    }
  }

  function downloadJson() {
    const blob = new Blob([JSON.stringify(aiPayload(), null, 2)], { type: 'application/json' })
    const link = document.createElement('a')
    link.href = URL.createObjectURL(blob)
    link.download = `html-edit-plan-${Date.now()}.json`
    link.click()
    setTimeout(() => URL.revokeObjectURL(link.href), 1000)
    setStatus('AI 改动清单已下载')
  }

  function setStatus(text) {
    state.status = text
    const node = shadow.querySelector('[data-status]')
    if (node) node.textContent = text
  }

  function safeValue(property) {
    if (!state.selected) return ''
    const existing = state.document.changes.find(item => item.selector === state.selected.selector)
    return existing?.styles?.[property] || getComputedStyle(state.selected.element)[property] || ''
  }

  function renderRecords() {
    const container = shadow.querySelector('[data-records]')
    if (!container) return
    const records = [
      ...state.document.creations.map(item => ({ type: 'creation', id: item.id, label: '新增文字框', detail: item.text || item.selector })),
      ...state.document.changes.map(item => ({ type: 'change', id: item.id, label: item.text ? '文字 / 样式改动' : '样式改动', detail: item.text?.value || item.context.text || item.selector })),
      ...state.document.annotations.map((item, index) => ({ type: 'annotation', id: item.id, label: `注释 ${index + 1} · ${item.anchor}`, detail: item.message })),
    ]
    container.innerHTML = records.length ? records.map(item => `<div><span class="kind">${item.type === 'creation' ? '新' : item.type === 'change' ? '改' : '注'}</span><span><b>${escapeHtml(item.label)}</b><small>${escapeHtml(item.detail)}</small></span><button data-remove="${item.type}:${item.id}" title="移除">×</button></div>`).join('') : '<p class="empty">还没有记录。先选择页面元素。</p>'
  }

  function escapeHtml(value) {
    return String(value || '').replace(/[&<>'"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[char])
  }

  function render() {
    root.classList.toggle('is-open', state.open)
    if (!state.open) { root.innerHTML = ''; return }
    const selected = state.selected
    root.innerHTML = `
      <div class="hover-outline" data-hover></div><div class="selected-outline" data-selected></div><div data-markers></div>
      <aside class="panel" ${EXTENSION_UI}>
        <header><div><strong>HTML 交互编辑器</strong><span>${escapeHtml(pageKey())}</span></div><button data-close title="关闭">×</button></header>
        <div class="toolbar has-undo"><button data-select aria-pressed="${state.selecting}" class="${state.selecting ? 'active' : ''}">⌖ 选择模式：${state.selecting ? '开' : '关'}</button><button data-undo ${state.history.length ? '' : 'disabled'}>↶ 撤销上一步</button><button data-reset>↺ 清空本页</button></div>
        <button class="add-textbox" data-add-textbox>＋ 添加文字框</button>
        <section><div class="section-title"><b>01</b><strong>当前元素</strong></div>
          ${selected ? `<div class="target"><b>${selected.context.tag}</b><code>${escapeHtml(selected.selector)}</code><p>${escapeHtml(selected.context.text || '无文本内容')}</p></div>` : '<p class="empty">开启选择模式后，可连续点击元素；按住选中元素拖动即可调整位置。</p>'}
          <div class="drag-settings"><span>拖动网格吸附</span><select data-grid><option value="4" ${state.gridSize === 4 ? 'selected' : ''}>4px</option><option value="8" ${state.gridSize === 8 ? 'selected' : ''}>8px</option><option value="12" ${state.gridSize === 12 ? 'selected' : ''}>12px</option><option value="16" ${state.gridSize === 16 ? 'selected' : ''}>16px</option></select></div>
        </section>
        <section><div class="section-title"><b>02</b><strong>内容、外观与层级</strong></div>
          <div class="text-editor">
            <label>文字内容</label>
            <textarea data-text placeholder="输入替换后的文字" ${selected ? '' : 'disabled'}>${escapeHtml(state.textDraft)}</textarea>
            <button data-apply-text ${selected ? '' : 'disabled'}>应用文字修改</button>
            <small>若所选元素包含图标或强调样式，修改时会替换其内部内容；恢复记录可还原原始结构。</small>
          </div>
          <div class="grid">
            <label>宽度<input data-style="width" value="${escapeHtml(selected ? safeValue('width') : '')}" placeholder="如 480px / 80%" ${selected ? '' : 'disabled'}></label>
            <label>高度<input data-style="height" value="${escapeHtml(selected ? safeValue('height') : '')}" placeholder="如 320px / auto" ${selected ? '' : 'disabled'}></label>
            <label>层级 z-index<input data-style="zIndex" value="${escapeHtml(selected ? safeValue('zIndex') : '')}" placeholder="如 20" ${selected ? '' : 'disabled'}></label>
            <label>圆角<input data-style="borderRadius" value="${escapeHtml(selected ? safeValue('borderRadius') : '')}" placeholder="如 16px" ${selected ? '' : 'disabled'}></label>
          </div>
          <div class="actions"><button data-hide ${selected ? '' : 'disabled'}>删减 / 隐藏</button><button data-show ${selected ? '' : 'disabled'}>恢复显示</button></div>
          <label class="upload ${selected ? '' : 'disabled'}">▧ 替换 / 添加图片<input data-image type="file" accept="image/*" ${selected ? '' : 'disabled'}></label>
          <div class="image-layout">
            <div class="image-layout-title"><strong>图片展示设置</strong><span>宽高 · 裁切 · 焦点</span></div>
            <div class="grid">
              <label>图像宽度<input data-image-layout="width" value="${escapeHtml(state.imageDraft.width)}" placeholder="100% / 320px" ${selected ? '' : 'disabled'}></label>
              <label>图像高度<input data-image-layout="height" value="${escapeHtml(state.imageDraft.height)}" placeholder="auto / 240px" ${selected ? '' : 'disabled'}></label>
              <label>填充方式<select data-image-layout="fit" ${selected ? '' : 'disabled'}><option value="cover" ${state.imageDraft.fit === 'cover' ? 'selected' : ''}>裁切铺满</option><option value="contain" ${state.imageDraft.fit === 'contain' ? 'selected' : ''}>完整显示</option><option value="fill" ${state.imageDraft.fit === 'fill' ? 'selected' : ''}>拉伸铺满</option><option value="custom" ${state.imageDraft.fit === 'custom' ? 'selected' : ''}>自定义尺寸</option></select></label>
              <label>水平位置 %<input data-image-layout="positionX" type="number" min="0" max="100" value="${state.imageDraft.positionX}" ${selected ? '' : 'disabled'}></label>
              <label>垂直位置 %<input data-image-layout="positionY" type="number" min="0" max="100" value="${state.imageDraft.positionY}" ${selected ? '' : 'disabled'}></label>
            </div>
            <p class="image-layout-help">宽高始终优先。预设控制框内裁切；选择“自定义尺寸”时按上方宽高直接缩放，不再继承 cover/contain。</p>
            <button data-apply-image-layout ${selected ? '' : 'disabled'}>应用图片展示设置</button>
          </div>
        </section>
        <section><div class="section-title"><b>03</b><strong>锁定位置注释</strong></div>
          <textarea data-note placeholder="例如：这里改为单行标题，弱化副标题层级" ${selected ? '' : 'disabled'}>${escapeHtml(state.noteDraft)}</textarea>
          <label class="anchor-label">元素内锚点（布局变化后仍跟随）</label>
          <div class="anchors">${Object.keys(anchors).map(name => `<button data-anchor="${name}" class="${name === state.anchor ? 'active' : ''}" title="${name}" ${selected ? '' : 'disabled'}></button>`).join('')}</div>
          <button class="primary" data-add-note ${selected ? '' : 'disabled'}>添加并锁定注释</button>
        </section>
        <section><div class="section-title"><b>04</b><strong>本页改动记录</strong></div><div class="records" data-records></div></section>
        <footer><span data-status>${escapeHtml(state.status)}</span><div><button data-copy>复制 AI 提示词 + 清单</button><button data-download>下载完整 JSON</button></div></footer>
      </aside>`
    bindUi()
    renderRecords()
    updateOverlays()
  }

  function bindUi() {
    shadow.querySelector('[data-close]')?.addEventListener('click', close)
    shadow.querySelector('[data-select]')?.addEventListener('click', () => {
      state.selecting = !state.selecting
      document.documentElement.style.cursor = state.selecting ? 'crosshair' : ''
      render()
    })
    shadow.querySelector('[data-reset]')?.addEventListener('click', resetPage)
    shadow.querySelector('[data-add-textbox]')?.addEventListener('click', addTextBox)
    shadow.querySelector('[data-undo]')?.addEventListener('click', undoLast)
    shadow.querySelector('[data-grid]')?.addEventListener('change', event => { state.gridSize = Number(event.target.value) || 8; setStatus(`拖动吸附网格已设为 ${state.gridSize}px`) })
    shadow.querySelector('[data-text]')?.addEventListener('input', event => { state.textDraft = event.target.value })
    shadow.querySelector('[data-apply-text]')?.addEventListener('click', applyText)
    shadow.querySelectorAll('[data-style]').forEach(input => input.addEventListener('change', event => changeStyle(event.target.dataset.style, event.target.value.trim())))
    shadow.querySelector('[data-hide]')?.addEventListener('click', () => changeStyle('display', 'none'))
    shadow.querySelector('[data-show]')?.addEventListener('click', restoreDisplay)
    shadow.querySelector('[data-image]')?.addEventListener('change', event => replaceImage(event.target.files?.[0]))
    shadow.querySelectorAll('[data-image-layout]').forEach(input => input.addEventListener('input', event => {
      const key = event.target.dataset.imageLayout
      state.imageDraft[key] = key === 'positionX' || key === 'positionY'
        ? Math.max(0, Math.min(100, Number(event.target.value) || 0))
        : event.target.value
    }))
    shadow.querySelector('[data-apply-image-layout]')?.addEventListener('click', applyImageLayout)
    shadow.querySelector('[data-note]')?.addEventListener('input', event => { state.noteDraft = event.target.value })
    shadow.querySelectorAll('[data-anchor]').forEach(button => button.addEventListener('click', () => { state.anchor = button.dataset.anchor; render() }))
    shadow.querySelector('[data-add-note]')?.addEventListener('click', addAnnotation)
    shadow.querySelector('[data-copy]')?.addEventListener('click', copyJson)
    shadow.querySelector('[data-download]')?.addEventListener('click', downloadJson)
    shadow.querySelectorAll('[data-remove]').forEach(button => button.addEventListener('click', () => { const [type, id] = button.dataset.remove.split(':'); removeRecord(type, id) }))
  }

  function updateOverlays() {
    if (!state.open) return
    const hover = shadow.querySelector('[data-hover]')
    const selected = shadow.querySelector('[data-selected]')
    positionOutline(hover, state.hover)
    positionOutline(selected, state.selected?.element)
    const markerLayer = shadow.querySelector('[data-markers]')
    if (!markerLayer) return
    markerLayer.innerHTML = state.document.annotations.map((note, index) => {
      const element = find(note.selector)
      if (!element || getComputedStyle(element).display === 'none') return ''
      const rect = element.getBoundingClientRect()
      const left = rect.left + rect.width * note.relativePosition.x
      const top = rect.top + rect.height * note.relativePosition.y
      return `<button class="marker" style="left:${left}px;top:${top}px" title="${escapeHtml(note.message)}">${index + 1}</button>`
    }).join('')
  }

  function positionOutline(node, element) {
    if (!node || !element || !element.isConnected || getComputedStyle(element).display === 'none') { if (node) node.style.display = 'none'; return }
    const rect = element.getBoundingClientRect()
    Object.assign(node.style, { display: 'block', left: `${rect.left}px`, top: `${rect.top}px`, width: `${rect.width}px`, height: `${rect.height}px` })
  }

  function onPointerMove(event) {
    if (!state.open || !state.selecting) return
    if (moveDrag(event)) return
    const path = event.composedPath()
    if (path.includes(host)) return
    state.hover = path.find(item => item instanceof Element && item !== document.documentElement && item !== document.body) || null
    updateOverlays()
  }

  function onPointerDown(event) {
    if (!state.open || !state.selecting || event.button !== 0) return
    const path = event.composedPath()
    if (path.includes(host)) return
    const element = path.find(item => item instanceof Element && item !== document.documentElement && item !== document.body)
    if (element) beginDrag(event, element)
  }

  function onClick(event) {
    if (!state.open || !state.selecting) return
    const path = event.composedPath()
    if (path.includes(host)) return
    if (state.suppressClick) {
      event.preventDefault(); event.stopPropagation(); event.stopImmediatePropagation()
      state.suppressClick = false
      return
    }
    const element = path.find(item => item instanceof Element && item !== document.documentElement && item !== document.body)
    if (!element) return
    event.preventDefault(); event.stopPropagation(); event.stopImmediatePropagation()
    selectElement(element)
  }

  function open() {
    if (!host.isConnected) document.documentElement.append(host)
    state.open = true
    load()
  }
  function close() {
    state.open = false; state.selecting = false; state.hover = null; state.drag = null; state.suppressClick = false
    document.documentElement.style.cursor = ''
    render()
  }
  function toggle() { state.open ? close() : open() }

  document.addEventListener('pointermove', onPointerMove, true)
  document.addEventListener('pointerdown', onPointerDown, true)
  document.addEventListener('pointerup', endDrag, true)
  document.addEventListener('pointercancel', endDrag, true)
  document.addEventListener('dragstart', event => {
    if (!state.open || !state.selecting || event.composedPath().includes(host)) return
    event.preventDefault()
  }, true)
  document.addEventListener('click', onClick, true)
  addEventListener('scroll', updateOverlays, true)
  addEventListener('resize', updateOverlays)
  const observer = new MutationObserver(() => {
    applyCreations()
    state.document.changes.forEach(applyChange)
    requestAnimationFrame(updateOverlays)
  })
  observer.observe(document.documentElement, { childList: true, subtree: true })
  setInterval(() => {
    if (!state.open || state.activePage === pageKey()) return
    state.selected = null
    state.hover = null
    load()
  }, 400)
  chrome.runtime.onMessage.addListener(message => { if (message?.type === 'INTERACTIVE_HTML_EDITOR_TOGGLE') toggle() })
  window.__INTERACTIVE_HTML_EDITOR__ = { open, close, toggle }
})()
