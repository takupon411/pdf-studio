pdfjsLib.GlobalWorkerOptions.workerSrc = 
  'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';

let pdfDoc = null;
let currentArrayBuffer = null;
let pageObserver = null;

let currentScale = 1.2;
let currentRotation = 0;
let draggedThumbIndex = null;

// ファイルハンドル & ファイル名管理
let currentFileHandle = null;
let currentFileName = 'document.pdf';

const container = document.getElementById('viewer-container');
const sidebar = document.getElementById('sidebar');
const thumbView = document.getElementById('thumbnail-view');
const outlineView = document.getElementById('outline-view');
const loadingOverlay = document.getElementById('loading-overlay');
const loadingText = document.getElementById('loading-text');
const progressBarFill = document.getElementById('progress-bar-fill');
const dropOverlay = document.getElementById('drop-overlay');

// --- プログレスバー UI 制御 ---
function updateProgress(percent, statusText = 'PDFを処理中...') {
  if (loadingOverlay) loadingOverlay.classList.add('active');
  const safePercent = Math.min(100, Math.max(0, Math.round(percent)));
  if (progressBarFill) progressBarFill.style.width = `${safePercent}%`;
  if (loadingText) loadingText.textContent = `${statusText} ${safePercent}%`;
}

function hideProgress() {
  setTimeout(() => {
    if (loadingOverlay) loadingOverlay.classList.remove('active');
    if (progressBarFill) progressBarFill.style.width = '0%';
  }, 200);
}

// --- ダウンロードユーティリティ ---
function downloadUint8Array(data, fileName) {
  const blob = new Blob([data], { type: 'application/pdf' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// --- PDFを閉じる（クリアする）機能 ---
function closePdf() {
  pdfDoc = null;
  currentArrayBuffer = null;
  currentFileHandle = null;
  currentFileName = 'document.pdf';

  if (pageObserver) {
    pageObserver.disconnect();
    pageObserver = null;
  }

  container.innerHTML = '<div class="placeholder-text">PDFファイルを読み込んでください</div>';
  thumbView.innerHTML = '';
  outlineView.innerHTML = '';

  document.getElementById('current-page').textContent = '0';
  document.getElementById('total-pages').textContent = '0';
  document.getElementById('print-start').value = 1;
  document.getElementById('print-end').value = 1;
  document.getElementById('file-input').value = '';
}

// --- ページ指定文字列の解析 ("1-3, 5, 7" ➔ [1, 2, 3, 5, 7]) ---
function parsePageRanges(rangeStr, totalPages) {
  const pages = new Set();
  const parts = rangeStr.split(',').map(s => s.trim());
  for (const part of parts) {
    if (!part) continue;
    if (part.includes('-')) {
      const [start, end] = part.split('-').map(n => parseInt(n.trim()));
      if (!isNaN(start) && !isNaN(end)) {
        const min = Math.max(1, Math.min(start, end));
        const max = Math.min(totalPages, Math.max(start, end));
        for (let i = min; i <= max; i++) {
          pages.add(i);
        }
      }
    } else {
      const pageNum = parseInt(part);
      if (!isNaN(pageNum) && pageNum >= 1 && pageNum <= totalPages) {
        pages.add(pageNum);
      }
    }
  }
  return Array.from(pages).sort((a, b) => a - b);
}

// --- 描画ヘルパー ---
function drawScaledPage(targetPage, embeddedPage, boxX, boxY, boxWidth, boxHeight) {
  const origW = embeddedPage.width;
  const origH = embeddedPage.height;

  const scale = Math.min(boxWidth / origW, boxHeight / origH);
  const fitW = origW * scale;
  const fitH = origH * scale;

  const x = boxX + (boxWidth - fitW) / 2;
  const y = boxY + (boxHeight - fitH) / 2;

  targetPage.drawPage(embeddedPage, {
    x: x,
    y: y,
    width: fitW,
    height: fitH
  });
}

function getSubBox(nMode, slotIndex, width, height) {
  if (nMode === 2) {
    const w = width / 2;
    return { x: slotIndex * w, y: 0, w: w, h: height };
  } else if (nMode === 3) {
    const w = width / 3;
    return { x: slotIndex * w, y: 0, w: w, h: height };
  } else {
    const w = width / 2;
    const h = height / 2;
    const col = slotIndex % 2;
    const row = Math.floor(slotIndex / 2);
    const y = row === 0 ? h : 0;
    return { x: col * w, y: y, w: w, h: h };
  }
}

// --- PDF読み込み処理 (複製保存でDetachedエラー回避) ---
function loadPdfData(arrayBuffer, fileName = null, fileHandle = null) {
  currentArrayBuffer = arrayBuffer.slice(0);
  if (fileName) currentFileName = fileName;
  if (fileHandle) currentFileHandle = fileHandle;

  const typedarray = new Uint8Array(arrayBuffer.slice(0));

  updateProgress(10, 'PDFを解析中...');

  pdfjsLib.getDocument({ data: typedarray }).promise.then(doc => {
    pdfDoc = doc;
    document.getElementById('total-pages').textContent = pdfDoc.numPages;
    document.getElementById('print-start').value = 1;
    document.getElementById('print-end').value = pdfDoc.numPages;

    renderMainPages();
    renderThumbnails();
    renderOutline();
  }).catch(err => {
    hideProgress();
    alert('PDF読み込みエラー: ' + err.message);
  });
}

// --- 1. メインページ描画 ---
async function renderMainPages() {
  if (!pdfDoc) return;
  container.innerHTML = '';
  initIntersectionObserver();

  const outputScale = window.devicePixelRatio || 1;

  for (let pageNum = 1; pageNum <= pdfDoc.numPages; pageNum++) {
    const page = await pdfDoc.getPage(pageNum);
    const viewport = page.getViewport({ scale: currentScale, rotation: currentRotation });

    const wrapper = document.createElement('div');
    wrapper.className = 'page-wrapper';
    wrapper.dataset.pageNumber = pageNum;

    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');

    canvas.width = Math.floor(viewport.width * outputScale);
    canvas.height = Math.floor(viewport.height * outputScale);
    canvas.style.width = `${Math.floor(viewport.width)}px`;
    canvas.style.height = `${Math.floor(viewport.height)}px`;

    wrapper.appendChild(canvas);
    container.appendChild(wrapper);

    const transform = outputScale !== 1 ? [outputScale, 0, 0, outputScale, 0, 0] : null;

    await page.render({
      canvasContext: ctx,
      viewport: viewport,
      transform: transform
    }).promise;

    pageObserver.observe(wrapper);

    updateProgress((pageNum / pdfDoc.numPages) * 100, '描画中...');
  }
  hideProgress();
}

// --- 2. スクロール監視 ---
function initIntersectionObserver() {
  if (pageObserver) pageObserver.disconnect();

  pageObserver = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
      if (entry.isIntersecting) {
        const pageNum = entry.target.dataset.pageNumber;
        document.getElementById('current-page').textContent = pageNum;
        
        const active = thumbView.querySelector('.thumb-wrapper.active');
        if (active) active.classList.remove('active');
        
        const currentThumb = thumbView.querySelector(`.thumb-wrapper[data-page-num="${pageNum}"]`);
        if (currentThumb) {
          currentThumb.classList.add('active');
          currentThumb.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        }
      }
    });
  }, { root: container, threshold: 0.5 });
}

function scrollToPage(pageNum) {
  const target = container.querySelector(`.page-wrapper[data-page-number="${pageNum}"]`);
  if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// --- 3. サムネイル描画 & ドラッグ＆ドロップ並び替え ---
async function renderThumbnails() {
  thumbView.innerHTML = '<div class="thumb-hint">↕ ドラッグ＆ドロップで並び替え</div>';

  for (let pageNum = 1; pageNum <= pdfDoc.numPages; pageNum++) {
    const page = await pdfDoc.getPage(pageNum);
    const viewport = page.getViewport({ scale: 0.25 });

    const thumbWrapper = document.createElement('div');
    thumbWrapper.className = 'thumb-wrapper';
    thumbWrapper.dataset.pageNum = pageNum;
    thumbWrapper.dataset.index = pageNum - 1;
    thumbWrapper.draggable = true;

    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    canvas.width = viewport.width;
    canvas.height = viewport.height;

    const label = document.createElement('div');
    label.className = 'thumb-label';
    label.textContent = `P. ${pageNum}`;

    thumbWrapper.appendChild(canvas);
    thumbWrapper.appendChild(label);
    thumbView.appendChild(thumbWrapper);

    await page.render({ canvasContext: ctx, viewport: viewport }).promise;

    thumbWrapper.addEventListener('click', () => scrollToPage(pageNum));

    thumbWrapper.addEventListener('dragstart', (e) => {
      draggedThumbIndex = parseInt(thumbWrapper.dataset.index);
      thumbWrapper.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
    });

    thumbWrapper.addEventListener('dragend', () => {
      thumbWrapper.classList.remove('dragging');
      document.querySelectorAll('.thumb-wrapper').forEach(el => el.classList.remove('drag-over'));
    });

    thumbWrapper.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      thumbWrapper.classList.add('drag-over');
    });

    thumbWrapper.addEventListener('dragleave', () => {
      thumbWrapper.classList.remove('drag-over');
    });

    thumbWrapper.addEventListener('drop', async (e) => {
      e.preventDefault();
      thumbWrapper.classList.remove('drag-over');
      const targetIndex = parseInt(thumbWrapper.dataset.index);

      if (draggedThumbIndex !== null && draggedThumbIndex !== targetIndex) {
        await reorderPages(draggedThumbIndex, targetIndex);
      }
    });
  }
}

// --- ページの並び替えロジック (pdf-lib) ---
async function reorderPages(fromIndex, toIndex) {
  if (!currentArrayBuffer) return;

  try {
    updateProgress(20, 'ページ順を変更中...');
    const srcPdf = await PDFLib.PDFDocument.load(currentArrayBuffer.slice(0));
    const newPdf = await PDFLib.PDFDocument.create();

    const pageIndices = srcPdf.getPageIndices();
    const movedItem = pageIndices.splice(fromIndex, 1)[0];
    pageIndices.splice(toIndex, 0, movedItem);

    const copiedPages = await newPdf.copyPages(srcPdf, pageIndices);
    copiedPages.forEach(p => newPdf.addPage(p));

    const newBytes = await newPdf.save();
    const buf = newBytes.buffer.slice(newBytes.byteOffset, newBytes.byteOffset + newBytes.byteLength);
    loadPdfData(buf);
  } catch (err) {
    hideProgress();
    alert('ページ並び替えエラー: ' + err.message);
  }
}

// --- 4. 目次描画 ---
async function renderOutline() {
  outlineView.innerHTML = '';
  const outline = await pdfDoc.getOutline();

  if (!outline || outline.length === 0) {
    outlineView.innerHTML = '<div style="color:#aaa; font-size:12px; padding:10px;">目次がありません</div>';
    return;
  }

  const ul = await buildOutlineTree(outline);
  outlineView.appendChild(ul);
}

async function buildOutlineTree(items) {
  const ul = document.createElement('ul');
  ul.className = 'outline-list';

  for (const item of items) {
    const li = document.createElement('li');
    const a = document.createElement('a');
    a.className = 'outline-link';
    a.textContent = item.title;

    if (item.dest) {
      let explicitDest = typeof item.dest === 'string' ? await pdfDoc.getDestination(item.dest) : item.dest;
      if (Array.isArray(explicitDest) && explicitDest.length > 0) {
        const pageIndex = await pdfDoc.getPageIndex(explicitDest[0]);
        const pageNum = pageIndex + 1;
        a.addEventListener('click', () => scrollToPage(pageNum));
      }
    }

    li.appendChild(a);
    if (item.items && item.items.length > 0) {
      li.appendChild(await buildOutlineTree(item.items));
    }
    ul.appendChild(li);
  }
  return ul;
}

// --- 5. PDF 編集機能 ---

// ① ファイル結合
document.getElementById('merge-file-input').addEventListener('change', async (e) => {
  const files = Array.from(e.target.files);
  if (files.length === 0) return;

  try {
    updateProgress(10, 'PDF結合の準備中...');
    const mergedPdf = await PDFLib.PDFDocument.create();

    if (currentArrayBuffer) {
      const basePdf = await PDFLib.PDFDocument.load(currentArrayBuffer.slice(0));
      const basePages = await mergedPdf.copyPages(basePdf, basePdf.getPageIndices());
      basePages.forEach(p => mergedPdf.addPage(p));
    }

    for (let i = 0; i < files.length; i++) {
      updateProgress(20 + (i / files.length) * 60, `結合中: ${files[i].name}`);
      const arrayBuf = await files[i].arrayBuffer();
      const addPdf = await PDFLib.PDFDocument.load(arrayBuf);
      const addPages = await mergedPdf.copyPages(addPdf, addPdf.getPageIndices());
      addPages.forEach(p => mergedPdf.addPage(p));
    }

    updateProgress(90, '結合データを生成中...');
    const mergedBytes = await mergedPdf.save();
    const buf = mergedBytes.buffer.slice(mergedBytes.byteOffset, mergedBytes.byteOffset + mergedBytes.byteLength);
    loadPdfData(buf);
    e.target.value = '';
  } catch (err) {
    hideProgress();
    alert('PDF結合エラー: ' + err.message);
  }
});

// ② N-in-1 集約合成
document.getElementById('nup-file-input').addEventListener('change', async (e) => {
  const files = Array.from(e.target.files);
  if (files.length === 0) return;

  const nMode = parseInt(document.getElementById('nup-select').value) || 4;

  try {
    updateProgress(10, `${nMode}in1 集約合成の準備中...`);

    const A3_WIDTH = 1190.55;
    const A3_HEIGHT = 841.89;

    const newPdf = await PDFLib.PDFDocument.create();
    let docsToProcess = [];

    if (files.length === 1 && currentArrayBuffer) {
      docsToProcess.push(await PDFLib.PDFDocument.load(currentArrayBuffer.slice(0)));
      docsToProcess.push(await PDFLib.PDFDocument.load(await files[0].arrayBuffer()));
    } else {
      for (const f of files) {
        const buf = await f.arrayBuffer();
        docsToProcess.push(await PDFLib.PDFDocument.load(buf));
      }
    }

    if (docsToProcess.length === 1) {
      const srcDoc = docsToProcess[0];
      const totalP = srcDoc.getPageCount();

      for (let i = 0; i < totalP; i += nMode) {
        updateProgress(20 + (i / totalP) * 70, 'ページ合成中...');
        const page = newPdf.addPage([A3_WIDTH, A3_HEIGHT]);

        for (let slot = 0; slot < nMode; slot++) {
          if (i + slot < totalP) {
            const [emb] = await newPdf.embedPdf(srcDoc, [i + slot]);
            const box = getSubBox(nMode, slot, A3_WIDTH, A3_HEIGHT);
            drawScaledPage(page, emb, box.x, box.y, box.w, box.h);
          }
        }
      }
    } else {
      const maxPages = Math.max(...docsToProcess.map(d => d.getPageCount()));

      for (let pageIdx = 0; pageIdx < maxPages; pageIdx++) {
        updateProgress(20 + (pageIdx / maxPages) * 70, `ページ ${pageIdx + 1} を合成中...`);
        const page = newPdf.addPage([A3_WIDTH, A3_HEIGHT]);

        for (let slot = 0; slot < Math.min(nMode, docsToProcess.length); slot++) {
          const doc = docsToProcess[slot];
          if (pageIdx < doc.getPageCount()) {
            const [emb] = await newPdf.embedPdf(doc, [pageIdx]);
            const box = getSubBox(nMode, slot, A3_WIDTH, A3_HEIGHT);
            drawScaledPage(page, emb, box.x, box.y, box.w, box.h);
          }
        }
      }
    }

    updateProgress(95, '集約PDFを生成中...');
    const mergedBytes = await newPdf.save();
    const buf = mergedBytes.buffer.slice(mergedBytes.byteOffset, mergedBytes.byteOffset + mergedBytes.byteLength);
    loadPdfData(buf);
    e.target.value = '';
  } catch (err) {
    hideProgress();
    alert('N-in-1 集約合成エラー: ' + err.message);
  }
});

// ③ ページ指定削除
document.getElementById('delete-pages-btn').addEventListener('click', async () => {
  if (!currentArrayBuffer || !pdfDoc) return;
  const inputStr = document.getElementById('delete-pages-input').value.trim();
  if (!inputStr) {
    alert('削除したいページ番号を入力してください。（例: 2, 4-6）');
    return;
  }

  const deletePages = parsePageRanges(inputStr, pdfDoc.numPages);
  if (deletePages.length === 0) {
    alert('有効なページ番号が指定されていません。');
    return;
  }

  if (deletePages.length >= pdfDoc.numPages) {
    alert('全ページを削除することはできません。');
    return;
  }

  try {
    updateProgress(20, 'ページ削除中...');
    const srcPdf = await PDFLib.PDFDocument.load(currentArrayBuffer.slice(0));
    const newPdf = await PDFLib.PDFDocument.create();

    const keepIndices = [];
    for (let i = 1; i <= pdfDoc.numPages; i++) {
      if (!deletePages.includes(i)) {
        keepIndices.push(i - 1);
      }
    }

    const copiedPages = await newPdf.copyPages(srcPdf, keepIndices);
    copiedPages.forEach(p => newPdf.addPage(p));

    const newBytes = await newPdf.save();
    document.getElementById('delete-pages-input').value = '';
    
    const buf = newBytes.buffer.slice(newBytes.byteOffset, newBytes.byteOffset + newBytes.byteLength);
    loadPdfData(buf);
  } catch (err) {
    hideProgress();
    alert('ページ削除エラー: ' + err.message);
  }
});

// ④ ファイル分割・抽出保存
document.getElementById('split-pages-btn').addEventListener('click', async () => {
  if (!currentArrayBuffer || !pdfDoc) return;
  const inputStr = document.getElementById('split-pages-input').value.trim();
  if (!inputStr) {
    alert('抽出したいページ範囲を入力してください。（例: 1-3）');
    return;
  }

  const extractPages = parsePageRanges(inputStr, pdfDoc.numPages);
  if (extractPages.length === 0) {
    alert('有効なページ範囲が指定されていません。');
    return;
  }

  try {
    updateProgress(20, '指定ページを抽出中...');
    const srcPdf = await PDFLib.PDFDocument.load(currentArrayBuffer.slice(0));
    const newPdf = await PDFLib.PDFDocument.create();

    const extractIndices = extractPages.map(p => p - 1);
    const copiedPages = await newPdf.copyPages(srcPdf, extractIndices);
    copiedPages.forEach(p => newPdf.addPage(p));

    const newBytes = await newPdf.save();
    hideProgress();
    downloadUint8Array(newBytes, `extracted_${inputStr.replace(/[^0-9-]/g, '_')}.pdf`);
  } catch (err) {
    hideProgress();
    alert('抽出エラー: ' + err.message);
  }
});

// ⑤ テキスト抽出 / CSV化機能
document.getElementById('extract-text-btn').addEventListener('click', async () => {
  if (!pdfDoc) {
    alert('PDFファイルが開かれていません。');
    return;
  }

  try {
    updateProgress(10, 'テキスト抽出を開始...');
    let csvContent = '\uFEFF"ページ","テキスト内容"\n';

    for (let pageNum = 1; pageNum <= pdfDoc.numPages; pageNum++) {
      const page = await pdfDoc.getPage(pageNum);
      const textContent = await page.getTextContent();

      const linesMap = new Map();
      textContent.items.forEach(item => {
        if (!item.str || item.str.trim() === '') return;
        const y = Math.round(item.transform[5]);
        if (!linesMap.has(y)) {
          linesMap.set(y, []);
        }
        linesMap.get(y).push(item);
      });

      const sortedY = Array.from(linesMap.keys()).sort((a, b) => b - a);

      const pageTextLines = sortedY.map(y => {
        const lineItems = linesMap.get(y);
        lineItems.sort((a, b) => a.transform[4] - b.transform[4]);
        return lineItems.map(it => it.str).join(' ');
      });

      const fullPageText = pageTextLines.join('\n');
      const escapedText = fullPageText.replace(/"/g, '""');
      csvContent += `"${pageNum}","${escapedText}"\n`;

      updateProgress(10 + (pageNum / pdfDoc.numPages) * 80, `テキスト抽出中... (${pageNum}/${pdfDoc.numPages})`);
    }

    updateProgress(95, 'CSVファイルを生成中...');
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'extracted_text.csv';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);

    hideProgress();
  } catch (err) {
    hideProgress();
    alert('テキスト抽出エラー: ' + err.message);
  }
});

// ⑥ 上書き保存・名前を付けて保存 機能
async function overwriteSave() {
  if (!currentArrayBuffer) {
    alert('保存するPDFが開かれていません。');
    return;
  }

  // FileSystem Access API が使える場合（直接ローカルファイルに書き込み）
  if (currentFileHandle && currentFileHandle.createWritable) {
    try {
      updateProgress(30, 'ファイルに上書き保存中...');
      const writable = await currentFileHandle.createWritable();
      await writable.write(currentArrayBuffer.slice(0));
      await writable.close();
      hideProgress();
      alert('上書き保存が完了しました。');
      return;
    } catch (err) {
      console.warn('直接上書き保存に失敗したためダウンロードで代替します', err);
    }
  }

  // FileHandleがない場合や代替処理
  downloadUint8Array(new Uint8Array(currentArrayBuffer.slice(0)), currentFileName);
}

async function saveAs() {
  if (!currentArrayBuffer) {
    alert('保存するPDFが開かれていません。');
    return;
  }

  // FileSystem Access API (showSaveFilePicker) 対応の場合
  if ('showSaveFilePicker' in window) {
    try {
      const options = {
        suggestedName: currentFileName.endsWith('.pdf') ? currentFileName : `${currentFileName}.pdf`,
        types: [{
          description: 'PDF Documents',
          accept: { 'application/pdf': ['.pdf'] }
        }]
      };
      const handle = await window.showSaveFilePicker(options);
      updateProgress(30, 'ファイルを保存中...');
      const writable = await handle.createWritable();
      await writable.write(currentArrayBuffer.slice(0));
      await writable.close();
      
      // 保存したファイルを現在の参照に更新
      currentFileHandle = handle;
      currentFileName = handle.name;
      hideProgress();
      alert('名前を付けて保存が完了しました。');
      return;
    } catch (err) {
      if (err.name === 'AbortError') return; // キャンセル時
      console.warn('showSaveFilePicker 失敗:', err);
    }
  }

  // 非対応ブラウザ向けフォールバック
  const newName = prompt('ファイル名を入力してください:', currentFileName);
  if (newName) {
    const finalName = newName.endsWith('.pdf') ? newName : `${newName}.pdf`;
    currentFileName = finalName;
    downloadUint8Array(new Uint8Array(currentArrayBuffer.slice(0)), finalName);
  }
}

// ドロップダウンメニュー制御
const saveMenuBtn = document.getElementById('save-menu-btn');
const saveDropdownMenu = document.getElementById('save-dropdown-menu');

if (saveMenuBtn && saveDropdownMenu) {
  saveMenuBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    saveDropdownMenu.classList.toggle('show');
  });

  window.addEventListener('click', () => {
    saveDropdownMenu.classList.remove('show');
  });
}

document.getElementById('overwrite-save-btn').addEventListener('click', () => {
  saveDropdownMenu.classList.remove('show');
  overwriteSave();
});

document.getElementById('save-as-btn').addEventListener('click', () => {
  saveDropdownMenu.classList.remove('show');
  saveAs();
});

// キーボードショートカット Ctrl+S / Cmd+S 対応
window.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === 's') {
    e.preventDefault();
    overwriteSave();
  }
});


// --- 6. ドラッグ＆ドロップ制御 ---
let dragCounter = 0;

['dragenter', 'dragover', 'dragleave', 'drop'].forEach(eventName => {
  window.addEventListener(eventName, (e) => {
    e.preventDefault();
    e.stopPropagation();
  }, false);
});

window.addEventListener('dragenter', () => {
  dragCounter++;
  if (dropOverlay) dropOverlay.classList.add('active');
});

window.addEventListener('dragover', (e) => {
  e.dataTransfer.dropEffect = 'copy';
});

window.addEventListener('dragleave', () => {
  dragCounter--;
  if (dragCounter === 0 && dropOverlay) {
    dropOverlay.classList.remove('active');
  }
});

window.addEventListener('drop', (e) => {
  dragCounter = 0;
  if (dropOverlay) dropOverlay.classList.remove('active');

  const files = e.dataTransfer.files;
  if (files.length > 0) {
    const file = files[0];
    if (file.type !== 'application/pdf' && !file.name.endsWith('.pdf')) {
      alert('PDFファイル（.pdf）のみ対応しています。');
      return;
    }

    const reader = new FileReader();
    reader.onloadstart = () => updateProgress(0, 'ファイルを準備中...');
    reader.onprogress = (evt) => {
      if (evt.lengthComputable) {
        updateProgress((evt.loaded / evt.total) * 100, 'ファイルを読み込み中...');
      }
    };
    reader.onload = (evt) => loadPdfData(evt.target.result, file.name);
    reader.readAsArrayBuffer(file);
  }
});

// --- 7. イベント登録 ---

document.getElementById('file-input').addEventListener('change', (e) => {
  if (e.target.files.length > 0) {
    const file = e.target.files[0];
    const reader = new FileReader();
    reader.onloadstart = () => updateProgress(0, 'ファイルを準備中...');
    reader.onprogress = (evt) => {
      if (evt.lengthComputable) {
        updateProgress((evt.loaded / evt.total) * 100, 'ファイルを読み込み中...');
      }
    };
    reader.onload = (evt) => loadPdfData(evt.target.result, file.name);
    reader.readAsArrayBuffer(file);
  }
});

document.getElementById('close-pdf-btn').addEventListener('click', closePdf);

document.getElementById('toggle-sidebar-btn').addEventListener('click', () => {
  sidebar.style.display = sidebar.style.display === 'none' ? 'flex' : 'none';
});

document.getElementById('tab-thumb').addEventListener('click', function() {
  this.classList.add('active');
  document.getElementById('tab-outline').classList.remove('active');
  thumbView.style.display = 'block';
  outlineView.style.display = 'none';
});

document.getElementById('tab-outline').addEventListener('click', function() {
  this.classList.add('active');
  document.getElementById('tab-thumb').classList.remove('active');
  thumbView.style.display = 'none';
  outlineView.style.display = 'block';
});

function updateZoomDisplay() {
  document.getElementById('zoom-level').textContent = `${Math.round(currentScale * 100)}%`;
}

document.getElementById('zoom-in-btn').addEventListener('click', () => {
  if (!pdfDoc) return;
  currentScale = Math.min(currentScale + 0.2, 3.0);
  updateZoomDisplay();
  renderMainPages();
});

document.getElementById('zoom-out-btn').addEventListener('click', () => {
  if (!pdfDoc) return;
  currentScale = Math.max(currentScale - 0.2, 0.4);
  updateZoomDisplay();
  renderMainPages();
});

document.getElementById('zoom-reset-btn').addEventListener('click', () => {
  if (!pdfDoc) return;
  currentScale = 1.0;
  updateZoomDisplay();
  renderMainPages();
});

document.getElementById('rotate-left-btn').addEventListener('click', () => {
  if (!pdfDoc) return;
  currentRotation = (currentRotation - 90 + 360) % 360;
  renderMainPages();
});

document.getElementById('rotate-right-btn').addEventListener('click', () => {
  if (!pdfDoc) return;
  currentRotation = (currentRotation + 90) % 360;
  renderMainPages();
});

document.getElementById('range-print-btn').addEventListener('click', async () => {
  if (!pdfDoc) return;
  const start = parseInt(document.getElementById('print-start').value) || 1;
  const end = parseInt(document.getElementById('print-end').value) || pdfDoc.numPages;

  const printContainer = document.getElementById('print-container');
  printContainer.innerHTML = '';
  updateProgress(0, '印刷データを生成中...');

  for (let pageNum = start; pageNum <= end; pageNum++) {
    const page = await pdfDoc.getPage(pageNum);
    const viewport = page.getViewport({ scale: 2.0, rotation: currentRotation });

    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    canvas.width = viewport.width;
    canvas.height = viewport.height;

    await page.render({ canvasContext: ctx, viewport: viewport }).promise;

    const img = document.createElement('img');
    img.src = canvas.toDataURL('image/png');
    img.className = 'print-page-img';
    printContainer.appendChild(img);
  }

  hideProgress();
  setTimeout(() => {
    window.print();
    printContainer.innerHTML = '';
  }, 300);
});

document.getElementById('full-print-btn').addEventListener('click', () => {
  if (!currentArrayBuffer) return;
  const blob = new Blob([currentArrayBuffer.slice(0)], { type: 'application/pdf' });
  const blobUrl = URL.createObjectURL(blob);
  
  let iframe = document.getElementById('pdf-print-iframe');
  if (!iframe) {
    iframe = document.createElement('iframe');
    iframe.id = 'pdf-print-iframe';
    iframe.style.display = 'none';
    document.body.appendChild(iframe);
  }
  iframe.src = blobUrl;
  iframe.onload = () => {
    setTimeout(() => {
      iframe.contentWindow.focus();
      iframe.contentWindow.print();
      URL.revokeObjectURL(blobUrl);
    }, 100);
  };
});