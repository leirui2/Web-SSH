// 初始化变量
const term = new Terminal({
    cursorBlink: true,
    scrollback: 1400,
    fontSize: 14
});
const fitAddon = new FitAddon.FitAddon();
let socket = null;
let currentKeyGroup = null; // 当前选中的按键组
let keyGroups = []; // 所有按键组

// ============ 自定义弹窗（替代原生 alert/confirm） ============
// SFTP 错误码友好提示映射
function friendlySFTPError(error) {
    if (!error) return '未知错误';
    const e = error.toUpperCase();
    if (e.includes('PERMISSION_DENIED')) return '没有写入权限，请检查远程目录权限';
    if (e.includes('NO_SUCH_FILE')) return '文件或目录不存在';
    if (e.includes('NO_SPACE')) return '远程磁盘空间不足';
    if (e.includes('QUOTA_EXCEEDED')) return '超出远程磁盘配额';
    if (e.includes('FILE_ALREADY_EXISTS')) return '文件已存在';
    if (e.includes('CONNECTION_REFUSED')) return '连接被拒绝';
    if (e.includes('TIMEOUT')) return '连接超时';
    if (e.includes('AUTH') || e.includes('PERMISSION')) return '认证失败或权限不足';
    return error;
}

function showAlert(message, title) {
    const overlay = document.getElementById('custom-overlay');
    document.getElementById('custom-dialog-title').textContent = title || '提示';
    document.getElementById('custom-dialog-body').textContent = message;
    const footer = document.getElementById('custom-dialog-footer');
    footer.innerHTML = '';
    const btn = document.createElement('button');
    btn.className = 'custom-btn custom-btn-primary';
    btn.textContent = '确定';
    btn.onclick = () => { overlay.style.display = 'none'; };
    footer.appendChild(btn);
    overlay.style.display = 'block';
    btn.focus();
}

function showConfirm(message, onConfirm, onCancel, title) {
    const overlay = document.getElementById('custom-overlay');
    document.getElementById('custom-dialog-title').textContent = title || '确认';
    document.getElementById('custom-dialog-body').textContent = message;
    const footer = document.getElementById('custom-dialog-footer');
    footer.innerHTML = '';
    const btnCancel = document.createElement('button');
    btnCancel.className = 'custom-btn custom-btn-secondary';
    btnCancel.textContent = '取消';
    const btnConfirm = document.createElement('button');
    btnConfirm.className = 'custom-btn custom-btn-primary';
    btnConfirm.textContent = '确定';
    const close = () => { overlay.style.display = 'none'; };
    btnCancel.onclick = () => { close(); if (onCancel) onCancel(); };
    btnConfirm.onclick = () => { close(); if (onConfirm) onConfirm(); };
    footer.appendChild(btnCancel);
    footer.appendChild(btnConfirm);
    overlay.style.display = 'block';
    btnConfirm.focus();
}

// 点击遮罩层空白区域关闭弹窗
document.addEventListener('DOMContentLoaded', () => {
    const overlay = document.getElementById('custom-overlay');
    overlay.addEventListener('click', (e) => {
        if (e.target === overlay) overlay.style.display = 'none';
    });
    document.getElementById('custom-dialog-close').addEventListener('click', () => {
        overlay.style.display = 'none';
    });
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && overlay.style.display === 'block') overlay.style.display = 'none';
    });
});

// 初始化终端
term.loadAddon(fitAddon);
const terminalElement = document.getElementById('terminal');
term.open(terminalElement);

// ============ 终端复制/粘贴支持 ============
// 内网 http（非安全上下文）下 navigator.clipboard 会被禁用，需降级到 execCommand 复制
function copyToClipboard(text) {
    if (!text) return;
    if (navigator.clipboard && window.isSecureContext) {
        navigator.clipboard.writeText(text).catch(() => fallbackCopy(text));
    } else {
        fallbackCopy(text);
    }
}
function fallbackCopy(text) {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.left = '-9999px';
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); } catch (e) { console.error('复制失败:', e); }
    document.body.removeChild(ta);
}

// 鼠标选中后自动复制
term.onSelectionChange(() => copyToClipboard(term.getSelection()));

// Ctrl+Shift+C 复制、Ctrl+Shift+V 粘贴（保留 Ctrl+C 作为终端中断信号）
term.attachCustomKeyEventHandler((e) => {
    if (e.type !== 'keydown') return true;
    if (e.ctrlKey && e.shiftKey && (e.key === 'C' || e.key === 'c')) {
        copyToClipboard(term.getSelection());
        return false;
    }
    if (e.ctrlKey && e.shiftKey && (e.key === 'V' || e.key === 'v')) {
        if (navigator.clipboard && window.isSecureContext) {
            navigator.clipboard.readText()
                .then(t => { if (t && typeof term.paste === 'function') term.paste(t); })
                .catch(() => {});
        }
        return false;
    }
    return true;
});

// 调整终端大小
function adjustTerminalSize() {
    try {
        fitAddon.fit();
    } catch (error) {
        console.warn('Fit method error:', error);
        const rect = terminalElement.getBoundingClientRect();
        const cols = Math.floor(rect.width / 9);
        const rows = Math.floor(rect.height / 18);
        term.resize(cols, rows);
    }
}

// 立即调整终端大小
adjustTerminalSize();

// 添加专门的终端输出处理函数
function writeToTerminal(text) {
    if (!term || !term.element) {
        console.error('Terminal not ready for writing');
        return;
    }
    
    try {
        term.write(text);
    } catch (e) {
        console.error('Failed to write to terminal:', e);
    }
}

// 窗口大小改变时重新调整终端
window.addEventListener('resize', () => {
    adjustTerminalSize();
    if (socket && socket.readyState === WebSocket.OPEN) {
        resizeTerminal();
    }
});

// SFTP相关功能
let uploadQueue = [];
let currentUploadFile = null;
let currentUploadRemotePath = null;
let uploadCancelled = false;
let downloadCancelled = false;
let fileSortColumn = 'name';
let fileSortAsc = true;
let currentFileList = [];

function initSFTPControls() {
    // 文件列表按钮事件
    document.getElementById('list-files-btn').addEventListener('click', listRemoteFiles);
    
    // 文件上传按钮事件
    document.getElementById('upload-btn').addEventListener('click', () => {
        document.getElementById('file-upload').click();
    });
    
    // 文件选择事件（多文件）
    document.getElementById('file-upload').addEventListener('change', handleFileUpload);
    
    // 取消上传/下载
    document.getElementById('cancel-upload-btn').addEventListener('click', cancelUpload);
    document.getElementById('cancel-download-btn').addEventListener('click', cancelDownload);
    
    // 文件下载按钮事件
    document.getElementById('download-btn').addEventListener('click', downloadFile);
    
    // 返回上一级目录按钮事件
    document.getElementById('parent-dir-btn').addEventListener('click', navigateToParentDirectory);
    
    // 文件搜索
    document.getElementById('file-search').addEventListener('input', () => {
        displayFileList(currentFileList);
    });
    
    // 拖拽上传
    const sftpControls = document.getElementById('sftp-controls');
    sftpControls.addEventListener('dragover', (e) => {
        e.preventDefault();
        e.stopPropagation();
        sftpControls.style.borderColor = '#4CAF50';
        sftpControls.style.borderWidth = '2px';
    });
    sftpControls.addEventListener('dragleave', (e) => {
        e.preventDefault();
        sftpControls.style.borderColor = '#ddd';
        sftpControls.style.borderWidth = '1px';
    });
    sftpControls.addEventListener('drop', handleDrop);
}

// 显示文件列表（支持排序+搜索）
function displayFileList(files) {
    currentFileList = files || [];
    const fileListElement = document.getElementById('file-list');
    fileListElement.style.display = 'block';
    fileListElement.innerHTML = '';
    
    if (!files || files.length === 0) {
        fileListElement.innerHTML = '<p>目录为空</p>';
        return;
    }
    
    // 搜索过滤
    const searchTerm = (document.getElementById('file-search')?.value || '').toLowerCase();
    let filteredFiles = files;
    if (searchTerm) {
        filteredFiles = files.filter(f => f.name.toLowerCase().includes(searchTerm));
    }
    
    if (filteredFiles.length === 0) {
        fileListElement.innerHTML = '<p>没有匹配的文件</p>';
        return;
    }
    
    // 排序
    const sortedFiles = [...filteredFiles].sort((a, b) => {
        // 目录始终排在前面
        if (a.isDirectory && !b.isDirectory) return -1;
        if (!a.isDirectory && b.isDirectory) return 1;
        
        let cmp = 0;
        switch (fileSortColumn) {
            case 'name':
                cmp = a.name.localeCompare(b.name);
                break;
            case 'size':
                cmp = (a.size || 0) - (b.size || 0);
                break;
            case 'modifiedTime':
                cmp = (a.modifiedTime || 0) - (b.modifiedTime || 0);
                break;
            case 'permissions':
                cmp = (a.permissions || '').localeCompare(b.permissions || '');
                break;
            default:
                cmp = a.name.localeCompare(b.name);
        }
        return fileSortAsc ? cmp : -cmp;
    });
    
    const table = document.createElement('table');
    table.style.width = '100%';
    table.style.borderCollapse = 'collapse';
    
    // 添加表头（可点击排序）
    const thead = document.createElement('thead');
    const headerRow = document.createElement('tr');
    const headers = [
        { key: 'name', label: '文件名' },
        { key: 'type', label: '类型' },
        { key: 'size', label: '大小' },
        { key: 'permissions', label: '权限' },
        { key: 'modifiedTime', label: '修改时间' }
    ];
    headers.forEach(h => {
        const th = document.createElement('th');
        const arrow = (fileSortColumn === h.key) ? (fileSortAsc ? ' ▲' : ' ▼') : '';
        th.textContent = h.label + arrow;
        th.style.border = '1px solid #ddd';
        th.style.padding = '5px';
        th.style.textAlign = 'left';
        th.style.cursor = 'pointer';
        th.style.userSelect = 'none';
        th.onclick = () => {
            if (fileSortColumn === h.key) {
                fileSortAsc = !fileSortAsc;
            } else {
                fileSortColumn = h.key;
                fileSortAsc = true;
            }
            displayFileList(currentFileList);
        };
        headerRow.appendChild(th);
    });
    thead.appendChild(headerRow);
    table.appendChild(thead);
    
    // 添加文件列表
    const tbody = document.createElement('tbody');
    sortedFiles.forEach(file => {
        const row = document.createElement('tr');
        row.style.cursor = 'pointer';
        row.onclick = () => {
            if (file.isDirectory) {
                document.getElementById('remote-path').value = file.path;
                listRemoteFiles();
            } else {
                document.getElementById('local-file-path').value = file.name;
            }
        };
        
        const cells = [
            file.name + (file.isDirectory ? '/' : ''),
            file.isDirectory ? '目录' : '文件',
            file.isDirectory ? '-' : formatFileSize(file.size),
            file.permissions,
            new Date(file.modifiedTime).toLocaleString()
        ];
        
        cells.forEach(cellText => {
            const td = document.createElement('td');
            td.textContent = cellText;
            td.style.border = '1px solid #ddd';
            td.style.padding = '5px';
            row.appendChild(td);
        });
        
        tbody.appendChild(row);
    });
    table.appendChild(tbody);
    fileListElement.appendChild(table);
}

// 格式化文件大小
function formatFileSize(bytes) {
    if (bytes < 1024) return bytes + ' B';
    else if (bytes < 1048576) return (bytes / 1024).toFixed(2) + ' KB';
    else if (bytes < 1073741824) return (bytes / 1048576).toFixed(2) + ' MB';
    else return (bytes / 1073741824).toFixed(2) + ' GB';
}

// 列出远程文件
function listRemoteFiles() {
    if (!socket || socket.readyState !== WebSocket.OPEN) {
        showAlert('请先连接到SSH服务器');
        return;
    }
    
    const remotePath = document.getElementById('remote-path').value || '/';
    const msg = JSON.stringify({
        type: 'sftp_list',
        path: remotePath
    });
    socket.send(msg);
}

// 处理文件上传（多文件队列）
function handleFileUpload(event) {
    const files = event.target.files;
    if (!files || files.length === 0) return;
    
    if (!socket || socket.readyState !== WebSocket.OPEN) {
        showAlert('请先连接到SSH服务器');
        return;
    }
    
    const remotePath = document.getElementById('remote-path').value || '/';
    
    // 构建上传队列
    uploadQueue = [];
    for (let i = 0; i < files.length; i++) {
        uploadQueue.push({ file: files[i], remotePath: remotePath, relativePath: '' });
    }
    
    showUploadProgress();
    processUploadQueue();
    
    document.getElementById('file-upload').value = '';
}

// 处理拖拽上传
async function handleDrop(e) {
    e.preventDefault();
    e.stopPropagation();
    const sftpControls = document.getElementById('sftp-controls');
    sftpControls.style.borderColor = '#ddd';
    sftpControls.style.borderWidth = '1px';
    
    if (!socket || socket.readyState !== WebSocket.OPEN) {
        showAlert('请先连接到SSH服务器');
        return;
    }
    
    const baseRemotePath = document.getElementById('remote-path').value || '/';
    const items = e.dataTransfer.items;
    uploadQueue = [];
    
    if (items && items.length > 0 && items[0].webkitGetAsEntry) {
        // 支持文件夹拖拽
        const entries = [];
        for (let i = 0; i < items.length; i++) {
            const entry = items[i].webkitGetAsEntry();
            if (entry) entries.push(entry);
        }
        for (const entry of entries) {
            await traverseEntry(entry, '', baseRemotePath);
        }
    } else {
        // 仅文件拖拽
        const files = e.dataTransfer.files;
        for (let i = 0; i < files.length; i++) {
            uploadQueue.push({ file: files[i], remotePath: baseRemotePath, relativePath: '' });
        }
    }
    
    if (uploadQueue.length > 0) {
        showUploadProgress();
        processUploadQueue();
    }
}

// 递归遍历拖拽的目录项
function traverseEntry(entry, relPath, baseRemotePath) {
    return new Promise((resolve) => {
        if (entry.isFile) {
            entry.file((file) => {
                uploadQueue.push({ file: file, remotePath: baseRemotePath, relativePath: relPath });
                resolve();
            });
        } else if (entry.isDirectory) {
            const dirReader = entry.createReader();
            const readEntries = () => {
                dirReader.readEntries(async (entries) => {
                    if (entries.length === 0) { resolve(); return; }
                    const currentRel = relPath ? relPath + '/' + entry.name : entry.name;
                    for (const childEntry of entries) {
                        await traverseEntry(childEntry, currentRel, baseRemotePath);
                    }
                    readEntries();
                });
            };
            readEntries();
        } else {
            resolve();
        }
    });
}

// 显示上传进度区域
function showUploadProgress() {
    const progressDiv = document.getElementById('upload-progress');
    progressDiv.style.display = 'block';
    document.getElementById('cancel-upload-btn').style.display = 'inline-block';
    document.getElementById('progress-text').textContent = `准备上传 ${uploadQueue.length} 个文件...`;
    document.getElementById('progress-bar').style.width = '0%';
    document.getElementById('speed-text').textContent = '';
}

// 处理上传队列
function processUploadQueue() {
    if (uploadCancelled) {
        uploadQueue = [];
        uploadCancelled = false;
        document.getElementById('cancel-upload-btn').style.display = 'none';
        return;
    }
    
    if (uploadQueue.length === 0) {
        currentUploadFile = null;
        document.getElementById('cancel-upload-btn').style.display = 'none';
        return;
    }
    
    const item = uploadQueue.shift();
    currentUploadFile = item.file;
    currentUploadRemotePath = item.remotePath;
    
    // 计算实际远程路径（含子目录）
    let actualRemotePath = item.remotePath;
    if (item.relativePath) {
        actualRemotePath = item.remotePath.replace(/\/$/, '') + '/' + item.relativePath;
    }
    
    window.pendingUploadFile = item.file;
    window.pendingUploadRemotePath = actualRemotePath;
    
    const remaining = uploadQueue.length;
    const pt = document.getElementById('progress-text');
    if (pt) pt.textContent = `[${remaining > 0 ? '队列剩 ' + remaining + ' 个' : '最后一个'}] ${item.file.name} - 等待服务器响应...`;
    
    // 发送上传请求
    const msg = JSON.stringify({
        type: 'sftp_upload',
        remotePath: actualRemotePath,
        fileName: item.file.name,
        fileSize: item.file.size
    });
    socket.send(msg);
}

// 取消上传
function cancelUpload() {
    uploadCancelled = true;
    if (currentUploadFile && socket && socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: 'sftp_upload_cancel', fileName: currentUploadFile.name }));
    }
    uploadQueue = [];
    const pt = document.getElementById('progress-text');
    if (pt) pt.textContent = '上传已取消';
    document.getElementById('cancel-upload-btn').style.display = 'none';
}

// 取消下载
function cancelDownload() {
    downloadCancelled = true;
    if (socket && socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: 'sftp_download_cancel' }));
    }
    document.getElementById('cancel-download-btn').style.display = 'none';
}

// 流式分片上传（支持断点续传 + 背压控制 + 速度显示）
function startStreamingUpload(file, remotePath, offset, resumeUpload) {
    const CHUNK_SIZE = 2 * 1024 * 1024; // 2MB
    const remainingSize = file.size - offset;
    const totalChunks = Math.ceil(remainingSize / CHUNK_SIZE);
    let chunkIndex = 0;
    let sentBytes = 0;
    const startTime = Date.now();
    
    const progressText = document.getElementById('progress-text');
    const progressBar = document.getElementById('progress-bar');
    const speedText = document.getElementById('speed-text');
    
    const sendChunk = () => {
        if (uploadCancelled) return;
        
        if (chunkIndex >= totalChunks) {
            progressText.textContent = '所有分片已发送，等待服务器处理...';
            return;
        }
        
        if (socket.readyState !== WebSocket.OPEN) {
            progressText.textContent = 'WebSocket连接已关闭，上传中断';
            return;
        }
        
        // 背压控制：WebSocket 发送缓冲区过大时等待
        if (socket.bufferedAmount > 4 * 1024 * 1024) {
            setTimeout(sendChunk, 50);
            return;
        }
        
        const start = offset + chunkIndex * CHUNK_SIZE;
        const end = Math.min(start + CHUNK_SIZE, file.size);
        const isLast = chunkIndex === totalChunks - 1;
        
        // 用 file.slice 流式读取，不加载整个文件到内存
        const chunkBlob = file.slice(start, end);
        const reader = new FileReader();
        reader.onload = (e) => {
            if (uploadCancelled) return;
            
            const chunkData = e.target.result;
            
            // 发送元数据
            const dataMsg = {
                type: 'sftp_data',
                fileName: file.name,
                remotePath: remotePath,
                chunkIndex: chunkIndex,
                totalChunks: totalChunks,
                isLastChunk: isLast,
                binaryTransfer: true,
                resumeUpload: resumeUpload
            };
            socket.send(JSON.stringify(dataMsg));
            
            // 发送二进制数据
            socket.send(chunkData);
            
            sentBytes += (end - start);
            const percent = Math.round((sentBytes / remainingSize) * 100);
            const sentMB = (sentBytes / 1024 / 1024).toFixed(1);
            const totalMB = (remainingSize / 1024 / 1024).toFixed(1);
            const tag = resumeUpload ? ' [续传]' : '';
            const queueTag = uploadQueue.length > 0 ? ` [队列剩 ${uploadQueue.length}]` : '';
            
            // 速度计算
            const elapsed = (Date.now() - startTime) / 1000;
            const speed = elapsed > 0 ? (sentBytes / 1024 / 1024 / elapsed).toFixed(1) : '0';
            const remainBytes = remainingSize - sentBytes;
            const remainTime = elapsed > 0 && speed > 0 ? Math.ceil(remainBytes / 1024 / 1024 / speed) : 0;
            
            progressText.textContent = `${file.name}: ${percent}% (${sentMB}MB / ${totalMB}MB)${tag}${queueTag}`;
            if (speedText) speedText.textContent = `${speed} MB/s, 剩余 ${remainTime}s`;
            progressBar.style.width = `${percent}%`;
            
            chunkIndex++;
            sendChunk();
        };
        reader.onerror = (e) => {
            progressText.textContent = `读取分片失败: ${e.target.error}`;
        };
        reader.readAsArrayBuffer(chunkBlob);
    };
    
    sendChunk();
}

// 下载文件
function downloadFile() {
    if (!socket || socket.readyState !== WebSocket.OPEN) {
        showAlert('请先连接到SSH服务器');
        return;
    }
    
    const remotePath = document.getElementById('remote-path').value || '/';
    const fileName = document.getElementById('local-file-path').value;
    
    if (!fileName) {
        showAlert('请输入要下载的文件名');
        return;
    }
    
    // 构建完整路径，避免重复的斜杠
    let fullPath;
    if (remotePath.endsWith('/')) {
        fullPath = remotePath + fileName;
    } else {
        fullPath = remotePath + '/' + fileName;
    }
    
    // 设置全局变量，用于识别接下来的二进制响应是文件下载
    window.expectedFileDownload = fileName;
    downloadCancelled = false;
    
    const msg = JSON.stringify({
        type: 'sftp_download',
        path: fullPath,
        fileName: fileName,
        binaryTransfer: true // 使用二进制传输
    });
    socket.send(msg);
}

// 初始化SFTP控件
initSFTPControls();

// 加载服务器配置列表
function loadServerConfigs() {
    return fetch('/api/ssh-servers')
        .then(response => response.json())
        .then(servers => {
            const select = document.getElementById('server-select');
            // 清空现有选项（保留"手动输入"选项）
            while (select.options.length > 1) {
                select.remove(1);
            }
            
            // 添加服务器选项
            servers.forEach(server => {
                const option = document.createElement('option');
                option.value = server.id;
                option.textContent = `${server.name} (${server.host}:${server.port})`;
                select.appendChild(option);
            });
            
            return servers;
        })
        .catch(error => {
            console.error('加载服务器配置失败:', error);
            return [];
        });
}

// 服务器选择变化事件
document.getElementById('server-select').addEventListener('change', function() {
    const serverId = this.value;
    // 保存选择到localStorage
    localStorage.setItem('lastSelectedServer', serverId);
    
    if (!serverId) {
        // 选择了"手动输入"，清空表单
        document.getElementById('host').value = '';
        document.getElementById('port').value = '22';
        document.getElementById('username').value = '';
        document.getElementById('password').value = '';
        return;
    }
    
    // 获取服务器详情并填充表单
    fetch(`/api/ssh-servers/${serverId}`)
        .then(response => response.json())
        .then(server => {
            document.getElementById('host').value = server.host;
            document.getElementById('port').value = server.port;
            document.getElementById('username').value = server.username;
            document.getElementById('password').value = server.password;
        })
        .catch(error => {
            console.error('获取服务器详情失败:', error);
        });
});

// 连接按钮事件
document.getElementById('connect-btn').addEventListener('click', connect);

// 断开连接按钮事件
document.getElementById('disconnect-btn').addEventListener('click', disconnect);

// 处理私钥文件选择
function handlePrivateKeyFileSelect(event) {
    const file = event.target.files[0];
    if (!file) return;
    
    const reader = new FileReader();
    reader.onload = function(e) {
        document.getElementById('private-key').value = e.target.result;
    };
    reader.readAsText(file);
}

// 初始化事件监听器
function initEventListeners() {
    // 确保DOM完全加载后再绑定事件
    document.addEventListener('DOMContentLoaded', function() {
        // 认证方式切换事件
        document.getElementById('auth-method').addEventListener('change', function() {
            const isPrivateKey = this.value === 'privatekey';
            document.getElementById('private-key-container').style.display = isPrivateKey ? 'block' : 'none';
            document.getElementById('password').required = !isPrivateKey;
        });
        
        // 私钥文件选择事件
        document.getElementById('private-key-file').addEventListener('change', handlePrivateKeyFileSelect);
        
        // 按键栏相关事件
        const addKeyBtn = document.getElementById('add-key-btn');
        if (addKeyBtn) {
            addKeyBtn.addEventListener('click', showAddKeyModal);
            console.log('绑定添加按键按钮事件');
        }
        
        const editGroupBtn = document.getElementById('edit-group-btn');
        if (editGroupBtn) {
            editGroupBtn.addEventListener('click', showEditGroupModal);
            console.log('绑定编辑组按钮事件');
        }
        
        const addGroupBtn = document.getElementById('add-group-btn');
        if (addGroupBtn) {
            addGroupBtn.addEventListener('click', showAddGroupModal);
            console.log('绑定添加组按钮事件');
        }
        
        const keyGroupSelect = document.getElementById('key-group-select');
        if (keyGroupSelect) {
            keyGroupSelect.addEventListener('change', function() {
                const groupId = this.value;
                // 保存选择到localStorage
                localStorage.setItem('lastSelectedKeyGroup', groupId);
                loadKeyButtons();
            });
            console.log('绑定按键组选择事件');
        }

        // 按键编辑对话框事件
        const keySaveBtn = document.getElementById('key-save-btn');
        if (keySaveBtn) {
            keySaveBtn.addEventListener('click', saveKey);
            console.log('绑定按键保存按钮事件');
        }
        
        const keyDeleteBtn = document.getElementById('key-delete-btn');
        if (keyDeleteBtn) {
            keyDeleteBtn.addEventListener('click', deleteKey);
            console.log('绑定按键删除按钮事件');
        }
        
        // 按键编辑对话框关闭按钮
        const keyEditModalClose = document.querySelector('#key-edit-modal .close');
        if (keyEditModalClose) {
            keyEditModalClose.addEventListener('click', function() {
                console.log('关闭按键编辑对话框');
                document.getElementById('key-edit-modal').style.display = 'none';
            });
        }

        // 按键组编辑对话框事件
        const groupSaveBtn = document.getElementById('group-save-btn');
        if (groupSaveBtn) {
            groupSaveBtn.addEventListener('click', saveKeyGroup);
            console.log('绑定组保存按钮事件');
        }
        
        const groupDeleteBtn = document.getElementById('group-delete-btn');
        if (groupDeleteBtn) {
            groupDeleteBtn.addEventListener('click', deleteKeyGroup);
            console.log('绑定组删除按钮事件');
        }
        
        // 按键组编辑对话框关闭按钮
        const groupEditModalClose = document.querySelector('#group-edit-modal .close');
        if (groupEditModalClose) {
            groupEditModalClose.addEventListener('click', function() {
                console.log('关闭组编辑对话框');
                document.getElementById('group-edit-modal').style.display = 'none';
            });
        }
        
        // 点击对话框外部关闭对话框
        window.addEventListener('click', function(event) {
            const keyEditModal = document.getElementById('key-edit-modal');
            if (event.target === keyEditModal) {
                console.log('点击外部关闭按键编辑对话框');
                keyEditModal.style.display = 'none';
            }
            
            const groupEditModal = document.getElementById('group-edit-modal');
            if (event.target === groupEditModal) {
                console.log('点击外部关闭组编辑对话框');
                groupEditModal.style.display = 'none';
            }
        });

        console.log('所有事件监听器已绑定');
    });
}

// 页面加载时加载服务器配置和按键组
loadServerConfigs().then(servers => {
    // 恢复上次选择的服务器
    const lastServerId = localStorage.getItem('lastSelectedServer');
    if (lastServerId) {
        const serverSelect = document.getElementById('server-select');
        if (serverSelect) {
            serverSelect.value = lastServerId;
            // 触发change事件以加载服务器详情
            serverSelect.dispatchEvent(new Event('change'));
        }
    }
});

loadKeyGroups().then(() => {
    // 如果没有按键组，创建默认按键组
    if (keyGroups.length === 0) {
        createDefaultKeyGroups();
    } else {
        // 恢复上次选择的按键组
        const lastGroupId = localStorage.getItem('lastSelectedKeyGroup');
        if (lastGroupId) {
            const groupSelect = document.getElementById('key-group-select');
            if (groupSelect) {
                groupSelect.value = lastGroupId;
                loadKeyButtons();
            }
        }
    }
});

// 初始化事件监听器
initEventListeners();

// 加载按键组配置
function loadKeyGroups() {
    return fetch('/api/terminal-key-groups')
        .then(response => {
            if (!response.ok) {
                if (response.status === 404) {
                    // API不存在，返回空数组
                    return [];
                }
                throw new Error('加载按键组配置失败: ' + response.statusText);
            }
            return response.json();
        })
        .then(groups => {
            keyGroups = groups || [];
            
            // 更新按键组选择框
            const select = document.getElementById('key-group-select');
            if (!select) return groups;
            
            select.innerHTML = '';
            
            groups.forEach(group => {
                const option = document.createElement('option');
                option.value = group.id;
                option.textContent = group.name;
                select.appendChild(option);
            });
            
            // 如果有按键组，加载第一个
            if (groups.length > 0) {
                currentKeyGroup = groups[0];
                select.value = groups[0].id;
                loadKeyButtons();
            }
            
            return groups;
        })
        .catch(error => {
            console.error('加载按键组配置失败:', error);
            return [];
        });
}

// 创建默认按键组
function createDefaultKeyGroups() {
    console.log('创建默认按键组...');
    
    // Linux常用命令组
    const linuxGroup = {
        id: generateUUID(),
        name: "Linux常用命令",
        keys: [
            {
                id: generateUUID(),
                label: "ls -la",
                command: "ls -la",
                color: "#4CAF50"
            },
            {
                id: generateUUID(),
                label: "pwd",
                command: "pwd",
                color: "#2196F3"
            },
            {
                id: generateUUID(),
                label: "top",
                command: "top",
                color: "#FF9800"
            },
            {
                id: generateUUID(),
                label: "df -h",
                command: "df -h",
                color: "#9C27B0"
            },
            {
                id: generateUUID(),
                label: "free -m",
                command: "free -m",
                color: "#607D8B"
            }
        ]
    };
    
    // Docker命令组
    const dockerGroup = {
        id: generateUUID(),
        name: "Docker命令",
        keys: [
            {
                id: generateUUID(),
                label: "docker ps",
                command: "docker ps",
                color: "#2196F3"
            },
            {
                id: generateUUID(),
                label: "docker images",
                command: "docker images",
                color: "#4CAF50"
            },
            {
                id: generateUUID(),
                label: "docker stats",
                command: "docker stats",
                color: "#FF9800"
            },
            {
                id: generateUUID(),
                label: "docker-compose ps",
                command: "docker-compose ps",
                color: "#9C27B0"
            }
        ]
    };
    
    // 保存默认按键组
    Promise.all([
        saveKeyGroupToServer(linuxGroup),
        saveKeyGroupToServer(dockerGroup)
    ])
    .then(() => {
        console.log('默认按键组创建成功');
        return loadKeyGroups();
    })
    .catch(error => {
        console.error('创建默认按键组失败:', error);
    });
}

// 加载按键按钮
function loadKeyButtons() {
    const groupId = document.getElementById('key-group-select').value;
    if (!groupId) {
        document.getElementById('key-buttons').innerHTML = '';
        return;
    }
    
    // 查找选中的按键组
    currentKeyGroup = keyGroups.find(group => group.id === groupId);
    if (!currentKeyGroup) {
        document.getElementById('key-buttons').innerHTML = '';
        return;
    }
    
    // 创建按键按钮
    const keyButtonsContainer = document.getElementById('key-buttons');
    keyButtonsContainer.innerHTML = '';
    
    currentKeyGroup.keys.forEach(key => {
        const button = document.createElement('button');
        button.className = 'key-button';
        button.textContent = key.label;
        button.style.backgroundColor = key.color || '#4CAF50';
        button.dataset.id = key.id;
        button.dataset.command = key.command;
        
        // 点击按钮发送命令到终端
        button.addEventListener('click', () => {
            if (socket && socket.readyState === WebSocket.OPEN) {
                const dataMsg = JSON.stringify({
                    type: 'data',
                    data: key.command
                });
                socket.send(dataMsg);
            } else {
                showAlert('请先连接到SSH服务器');
            }
        });
        
        // 右键点击编辑按钮
        button.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            showEditKeyModal(key);
        });
        
        keyButtonsContainer.appendChild(button);
    });
}

// 显示添加按键对话框
function showAddKeyModal() {
    if (!currentKeyGroup) {
        showAlert('请先选择或创建一个按键组');
        return;
    }
    
    document.getElementById('key-edit-title').textContent = '添加按键';
    document.getElementById('key-edit-id').value = '';
    document.getElementById('key-edit-label').value = '';
    document.getElementById('key-edit-command').value = '';
    document.getElementById('key-edit-color').value = '#4CAF50';
    document.getElementById('key-delete-btn').style.display = 'none';
    document.getElementById('key-edit-modal').style.display = 'block';
}

// 显示编辑按键对话框
function showEditKeyModal(key) {
    document.getElementById('key-edit-title').textContent = '编辑按键';
    document.getElementById('key-edit-id').value = key.id;
    document.getElementById('key-edit-label').value = key.label;
    document.getElementById('key-edit-command').value = key.command;
    document.getElementById('key-edit-color').value = key.color || '#4CAF50';
    document.getElementById('key-delete-btn').style.display = 'block';
    document.getElementById('key-edit-modal').style.display = 'block';
}

// 保存按键
function saveKey() {
    if (!currentKeyGroup) {
        showAlert('请先选择或创建一个按键组');
        return;
    }
    
    const keyId = document.getElementById('key-edit-id').value;
    const keyLabel = document.getElementById('key-edit-label').value.trim();
    const keyCommand = document.getElementById('key-edit-command').value;
    const keyColor = document.getElementById('key-edit-color').value;
    
    if (!keyLabel || !keyCommand) {
        showAlert('请填写有效的按键标签和命令');
        return;
    }
    
    console.log('保存按键:', {keyId, keyLabel, keyCommand, keyColor});
    
    // 创建或更新按键
    if (keyId) {
        // 更新现有按键
        const keyIndex = currentKeyGroup.keys.findIndex(k => k.id === keyId);
        if (keyIndex !== -1) {
            currentKeyGroup.keys[keyIndex] = {
                id: keyId,
                label: keyLabel,
                command: keyCommand,
                color: keyColor
            };
            console.log('更新现有按键:', currentKeyGroup.keys[keyIndex]);
        }
    } else {
        // 创建新按键
        const newKey = {
            id: generateUUID(),
            label: keyLabel,
            command: keyCommand,
            color: keyColor
        };
        currentKeyGroup.keys.push(newKey);
        console.log('添加新按键:', newKey);
    }
    
    // 保存按键组
    console.log('准备保存按键组:', currentKeyGroup);
    saveKeyGroupToServer(currentKeyGroup)
        .then(() => {
            console.log('保存成功，关闭对话框');
            document.getElementById('key-edit-modal').style.display = 'none';
            return loadKeyButtons();
        })
        .then(() => {
            console.log('按键按钮重新加载完成');
        })
        .catch(error => {
            console.error('保存按键失败:', error);
            showAlert('保存按键失败: ' + error.message);
        });
}

// 删除按键
function deleteKey() {
    if (!currentKeyGroup) {
        return;
    }
    
    const keyId = document.getElementById('key-edit-id').value;
    if (!keyId) {
        return;
    }
    
    showConfirm('确定要删除这个按键吗？', () => {
    // 从按键组中删除按键
    currentKeyGroup.keys = currentKeyGroup.keys.filter(key => key.id !== keyId);
    
    // 保存按键组
    saveKeyGroupToServer(currentKeyGroup)
        .then(() => {
            document.getElementById('key-edit-modal').style.display = 'none';
            loadKeyButtons();
        })
        .catch(error => {
            console.error('删除按键失败:', error);
            showAlert('删除按键失败: ' + error.message);
        });
    });
}

// 显示添加按键组对话框
function showAddGroupModal() {
    document.getElementById('group-edit-title').textContent = '添加按键组';
    document.getElementById('group-edit-id').value = '';
    document.getElementById('group-edit-name').value = '';
    document.getElementById('group-keys-list').innerHTML = '';
    document.getElementById('group-delete-btn').style.display = 'none';
    document.getElementById('group-edit-modal').style.display = 'block';
}

// 显示编辑按键组对话框
function showEditGroupModal() {
    if (!currentKeyGroup) {
        showAlert('请先选择一个按键组');
        return;
    }
    
    document.getElementById('group-edit-title').textContent = '编辑按键组';
    document.getElementById('group-edit-id').value = currentKeyGroup.id;
    document.getElementById('group-edit-name').value = currentKeyGroup.name;
    
    // 显示按键列表
    const keysList = document.getElementById('group-keys-list');
    keysList.innerHTML = '';
    
    if (currentKeyGroup.keys && currentKeyGroup.keys.length > 0) {
        const table = document.createElement('table');
        table.style.width = '100%';
        table.style.borderCollapse = 'collapse';
        
        // 添加表头
        const thead = document.createElement('thead');
        const headerRow = document.createElement('tr');
        const headers = ['按键标签', '命令', '操作'];
        headers.forEach(headerText => {
            const th = document.createElement('th');
            th.textContent = headerText;
            th.style.border = '1px solid #ddd';
            th.style.padding = '5px';
            th.style.textAlign = 'left';
            headerRow.appendChild(th);
        });
        thead.appendChild(headerRow);
        table.appendChild(thead);
        
        // 添加按键列表
        const tbody = document.createElement('tbody');
        currentKeyGroup.keys.forEach(key => {
            const row = document.createElement('tr');
            
            // 按键标签
            const labelCell = document.createElement('td');
            labelCell.textContent = key.label;
            labelCell.style.border = '1px solid #ddd';
            labelCell.style.padding = '5px';
            row.appendChild(labelCell);
            
            // 按键命令
            const commandCell = document.createElement('td');
            commandCell.textContent = key.command;
            commandCell.style.border = '1px solid #ddd';
            commandCell.style.padding = '5px';
            row.appendChild(commandCell);
            
            // 操作按钮
            const actionCell = document.createElement('td');
            actionCell.style.border = '1px solid #ddd';
            actionCell.style.padding = '5px';
            
            const editButton = document.createElement('button');
            editButton.textContent = '编辑';
            editButton.className = 'btn';
            editButton.style.fontSize = '12px';
            editButton.style.padding = '2px 5px';
            editButton.style.marginRight = '5px';
            editButton.addEventListener('click', () => {
                document.getElementById('group-edit-modal').style.display = 'none';
                showEditKeyModal(key);
            });
            actionCell.appendChild(editButton);
            
            row.appendChild(actionCell);
            tbody.appendChild(row);
        });
        table.appendChild(tbody);
        keysList.appendChild(table);
    } else {
        keysList.innerHTML = '<p>没有按键</p>';
    }
    
    document.getElementById('group-delete-btn').style.display = 'block';
    document.getElementById('group-edit-modal').style.display = 'block';
}

// 保存按键组
function saveKeyGroup() {
    const groupId = document.getElementById('group-edit-id').value;
    const groupName = document.getElementById('group-edit-name').value.trim();
    
    if (!groupName) {
        showAlert('请填写有效的按键组名称');
        return;
    }
    
    console.log('正在保存按键组:', groupName, 'ID:', groupId || '新按键组');
    
    let keyGroup;
    let isNewGroup = false;
    
    if (groupId) {
        // 更新现有按键组
        keyGroup = keyGroups.find(group => group.id === groupId);
        if (!keyGroup) {
            showAlert('错误: 找不到要更新的按键组');
            console.error('找不到按键组:', groupId);
            return;
        }
        keyGroup.name = groupName;
        console.log('更新现有按键组:', keyGroup);
    } else {
        // 创建新按键组
        keyGroup = {
            name: groupName,
            keys: []
        };
        isNewGroup = true;
        console.log('创建新按键组:', keyGroup);
    }
    
    // 保存按键组
    saveKeyGroupToServer(keyGroup, isNewGroup)
        .then((savedGroup) => {
            console.log('按键组保存成功:', savedGroup);
            document.getElementById('group-edit-modal').style.display = 'none';
            return loadKeyGroups();
        })
        .then(() => {
            console.log('按键组重新加载完成');
            // 选择新创建的按键组
            if (isNewGroup) {
                const select = document.getElementById('key-group-select');
                if (select && keyGroups.length > 0) {
                    const newGroup = keyGroups.find(g => g.name === groupName);
                    if (newGroup) {
                        console.log('选择新按键组:', newGroup);
                        select.value = newGroup.id;
                        currentKeyGroup = newGroup;
                        loadKeyButtons();
                    }
                }
            }
        })
        .catch(error => {
            console.error('保存按键组失败:', error);
            showAlert('保存按键组失败: ' + error.message);
        });
}

// 删除按键组
function deleteKeyGroup() {
    const groupId = document.getElementById('group-edit-id').value;
    if (!groupId) {
        return;
    }
    
    showConfirm('确定要删除这个按键组吗？', () => {
    // 从服务器删除按键组
    fetch(`/api/terminal-key-groups/${groupId}`, {
        method: 'DELETE'
    })
    .then(response => {
        if (response.ok) {
            document.getElementById('group-edit-modal').style.display = 'none';
            keyGroups = keyGroups.filter(group => group.id !== groupId);
            loadKeyGroups();
        } else {
            throw new Error('删除按键组失败');
        }
    })
    .catch(error => {
        console.error('删除按键组失败:', error);
        showAlert('删除按键组失败: ' + error.message);
    });
    });
}

// 保存按键组到服务器
function saveKeyGroupToServer(keyGroup, isNewGroup = false) {
    const method = isNewGroup ? 'POST' : 'PUT';
    const url = isNewGroup ? '/api/terminal-key-groups' : `/api/terminal-key-groups/${keyGroup.id}`;
    
    console.log('发送请求到:', url, '方法:', method);
    console.log('请求数据:', keyGroup);

    return fetch(url, {
        method: method,
        headers: {
            'Content-Type': 'application/json',
            'Accept': 'application/json'
        },
        body: JSON.stringify(keyGroup)
    })
    .then(async response => {
        const text = await response.text();
        console.log('收到响应:', response.status, text);
        
        if (!response.ok) {
            console.error('保存按键组失败，状态码:', response.status);
            throw new Error(text || response.statusText);
        }

        try {
            const data = text ? JSON.parse(text) : {};
            // 如果是新建的按键组，更新ID
            if (isNewGroup && data.id) {
                keyGroup.id = data.id;
            }
            return data;
        } catch (e) {
            console.warn('解析响应JSON失败:', e);
            throw new Error('服务器返回了无效的响应');
        }
    })
    .then(data => {
        console.log('解析后的数据:', data);
        
        // 更新本地按键组列表
        const existingIndex = keyGroups.findIndex(g => g.id === keyGroup.id);
        if (existingIndex !== -1) {
            keyGroups[existingIndex] = keyGroup;
        } else {
            keyGroups.push(keyGroup);
        }
        
        return data;
    })
    .catch(error => {
        console.error('保存按键组请求失败:', error);
        throw new Error('保存失败: ' + error.message);
    });
}

// 生成UUID
function generateUUID() {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
        const r = Math.random() * 16 | 0;
        const v = c === 'x' ? r : (r & 0x3 | 0x8);
        return v.toString(16);
    });
}

// 连接SSH服务器
function connect() {
    const host = document.getElementById('host').value;
    const port = document.getElementById('port').value;
    const username = document.getElementById('username').value;
    const authMethod = document.getElementById('auth-method').value;
    
    if (!host || !username) {
        showAlert('请填写主机和用户名');
        return;
    }
    
    let authData = {};
    if (authMethod === 'password') {
        const password = document.getElementById('password').value;
        if (!password) {
            showAlert('请填写密码');
            return;
        }
        authData = {
            type: 'password',
            password: password
        };
    } else {
        const privateKey = document.getElementById('private-key').value.trim();
        if (!privateKey) {
            showAlert('请提供私钥内容');
            return;
        }
        authData = {
            type: 'privatekey',
            privateKey: privateKey,
            passphrase: document.getElementById('passphrase').value || undefined
        };
    }
    
    
    // 构建WebSocket URL
    const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${wsProtocol}//${window.location.host}/ssh-connect`;
    
    try {
        // 创建WebSocket连接
        socket = new WebSocket(wsUrl);
        
        // WebSocket连接事件
        socket.onopen = () => {
            console.log('WebSocket连接已建立');
            document.getElementById('status').innerHTML = '连接中...';
            document.getElementById('status').className = 'status status-disconnected';
            
            // 发送连接请求
            const connectMsg = JSON.stringify({
                type: 'connect',
                host: host,
                port: parseInt(port),
                username: username,
                auth: authData,
                cols: term.cols,
                rows: term.rows
            });
            socket.send(connectMsg);
        };
        
        // 接收消息事件
        socket.onmessage = async (event) => {
            // 检查终端是否存在
            if (!term || !term.element) {
                console.error('Terminal not initialized');
                return;
            }
            
            // 处理二进制数据
            if (event.data instanceof ArrayBuffer || event.data instanceof Blob) {
                // 检查是否是文件下载分块数据
                if (window.fileDownloadInProgress) {
                    let chunk;
                    if (event.data instanceof Blob) {
                        chunk = await event.data.arrayBuffer();
                    } else {
                        chunk = event.data;
                    }
                    window.fileDownloadChunks.push(chunk);
                    window.fileDownloadReceived += chunk.byteLength;
                    const progress = window.fileDownloadTotal > 0
                        ? Math.round(window.fileDownloadReceived / window.fileDownloadTotal * 100)
                        : 0;
                    const elapsed = (Date.now() - (window.fileDownloadStartTime || Date.now())) / 1000;
                    const speed = elapsed > 0 ? (window.fileDownloadReceived / 1024 / 1024 / elapsed).toFixed(1) : '0';
                    const remainBytes = window.fileDownloadTotal - window.fileDownloadReceived;
                    const remainTime = elapsed > 0 && speed > 0 ? Math.ceil(remainBytes / 1024 / 1024 / speed) : 0;
                    const statusEl = document.getElementById('status');
                    if (statusEl) {
                        statusEl.textContent = `下载 ${window.fileDownloadName}: ${progress}% (${(window.fileDownloadReceived/1024/1024).toFixed(1)}MB / ${(window.fileDownloadTotal/1024/1024).toFixed(1)}MB) ${speed}MB/s 剩余${remainTime}s`;
                    }
                    return;
                }

                // 检查是否是旧版单次文件下载
                if (window.expectedFileDownload) {
                    const blob = event.data instanceof Blob ? event.data : new Blob([event.data], {type: 'application/octet-stream'});
                    const url = URL.createObjectURL(blob);
                    
                    const a = document.createElement('a');
                    a.href = url;
                    a.download = window.expectedFileDownload;
                    document.body.appendChild(a);
                    a.click();
                    document.body.removeChild(a);
                    URL.revokeObjectURL(url);
                    
                    showAlert('文件下载成功: ' + window.expectedFileDownload);
                    window.expectedFileDownload = null;
                    return;
                }
                
                // 否则当作终端输出处理
                let arrayBuffer;
                if (event.data instanceof Blob) {
                    arrayBuffer = await event.data.arrayBuffer();
                } else {
                    arrayBuffer = event.data;
                }
                const data = new TextDecoder('utf-8').decode(arrayBuffer);
                if (data && data.trim().length > 0) {
                    try {
                        term.write(data);
                    } catch (e) {
                        console.error('Error writing to terminal:', e);
                    }
                }
            } 
            // 处理文本消息（控制消息）
            else if (typeof event.data === 'string') {
                try {
                    const msg = JSON.parse(event.data);
                    
                    // 根据消息类型处理
                    switch (msg.type) {
                        case 'connect':
                            if (msg.status === 'success') {
                                const host = document.getElementById('host').value;
                                document.getElementById('status').innerHTML = '已连接到 ' + host;
                                document.getElementById('status').className = 'status status-connected';
                                document.getElementById('connect-btn').disabled = true;
                                document.getElementById('disconnect-btn').disabled = false;
                                document.getElementById('sftp-controls').style.display = 'block';
                                document.getElementById('terminal-keybar').style.display = 'block';
                            }
                            break;
                        case 'error':
                            term.write("\r\n[ERROR] " + msg.message + "\r\n");
                            // 连接失败时重置 UI
                            if (document.getElementById('connect-btn').disabled) {
                                document.getElementById('connect-btn').disabled = false;
                                document.getElementById('disconnect-btn').disabled = true;
                            }
                            document.getElementById('status').innerHTML = '连接失败';
                            document.getElementById('status').className = 'status status-disconnected';
                            document.getElementById('sftp-controls').style.display = 'none';
                            document.getElementById('terminal-keybar').style.display = 'none';
                            if (socket) { socket.close(); socket = null; }
                            break;
                        case 'disconnect':
                            disconnect();
                            term.write("\r\n[DISCONNECTED] 连接已断开\r\n");
                            break;
                        case 'output':
                            // 处理文本格式的输出消息
                            if (term && term.element) {
                                // 处理转义字符
                                const output = msg.data.replace(/\\n/g, '\n').replace(/\\r/g, '\r').replace(/\\\\/g, '\\');
                                term.write(output);
                            }
                            break;
                        case 'sftp_list_result':
                            // 显示文件列表
                            displayFileList(msg.files);
                            break;
                        case 'sftp_upload_ready':
                            {
                                const file = window.pendingUploadFile;
                                const remotePath = window.pendingUploadRemotePath;
                                if (!file) { console.error('没有待上传的文件'); break; }
                                
                                const remoteExistingSize = msg.remoteExistingSize || 0;
                                let offset = 0;
                                let resumeUpload = false;
                                
                                if (remoteExistingSize > 0 && remoteExistingSize < file.size) {
                                    showConfirm(`远程文件已存在 ${(remoteExistingSize/1024/1024).toFixed(1)}MB，本地文件 ${(file.size/1024/1024).toFixed(1)}MB。\n是否断点续传？`, () => {
                                        startStreamingUpload(file, remotePath, remoteExistingSize, true);
                                    }, () => {
                                        startStreamingUpload(file, remotePath, 0, false);
                                    }, '断点续传');
                                } else if (remoteExistingSize === file.size && file.size > 0) {
                                    showConfirm(`远程文件已存在且大小相同 (${(file.size/1024/1024).toFixed(1)}MB)。\n是否重新上传覆盖？`, () => {
                                        startStreamingUpload(file, remotePath, 0, false);
                                    }, () => {
                                        window.pendingUploadFile = null;
                                        processUploadQueue();
                                    }, '覆盖确认');
                                } else if (remoteExistingSize > file.size) {
                                    showConfirm(`远程文件 (${(remoteExistingSize/1024/1024).toFixed(1)}MB) 比本地文件 (${(file.size/1024/1024).toFixed(1)}MB) 大。\n是否重新上传覆盖？`, () => {
                                        startStreamingUpload(file, remotePath, 0, false);
                                    }, () => {
                                        window.pendingUploadFile = null;
                                        processUploadQueue();
                                    }, '覆盖确认');
                                } else {
                                    startStreamingUpload(file, remotePath, 0, false);
                                }
                            }
                            break;
                        case 'sftp_chunk_received':
                            // 分片确认，流式上传中不需要处理（背压由 bufferedAmount 控制）
                            break;
                        case 'sftp_upload_result':
                            if (msg.success) {
                                window.pendingUploadFile = null;
                                const pt = document.getElementById('progress-text');
                                const pb = document.getElementById('progress-bar');
                                if (pt) pt.textContent = '上传完成 ✓ ' + msg.fileName;
                                if (pb) pb.style.width = '100%';
                                let alertMsg = '文件上传成功: ' + msg.fileName;
                                if (msg.resumed) alertMsg += ' (断点续传)';
                                if (msg.localMd5 && msg.remoteMd5) {
                                    alertMsg += '\n\n本地 MD5:  ' + msg.localMd5;
                                    alertMsg += '\n远程 MD5:  ' + msg.remoteMd5;
                                    alertMsg += '\nMD5 校验:  ' + (msg.md5Match ? '✅ 一致' : '❌ 不一致');
                                }
                                showAlert(alertMsg);
                                // 处理队列中下一个文件
                                processUploadQueue();
                                // 全部上传完成，自动刷新文件列表
                                if (uploadQueue.length === 0 && !currentUploadFile) {
                                    listRemoteFiles();
                                }
                            } else {
                                const pt = document.getElementById('progress-text');
                                if (pt) pt.textContent = '上传失败: ' + friendlySFTPError(msg.error);
                                if (!msg.cancelled) showAlert('文件上传失败: ' + friendlySFTPError(msg.error));
                                // 失败后继续处理队列
                                processUploadQueue();
                            }
                            break;
                        case 'sftp_download_start':
                            console.log('[下载] 收到 sftp_download_start', msg);
                            window.fileDownloadInProgress = true;
                            window.fileDownloadChunks = [];
                            window.fileDownloadReceived = 0;
                            window.fileDownloadTotal = msg.fileSize;
                            window.fileDownloadName = msg.fileName;
                            window.fileDownloadStartTime = Date.now();
                            window.expectedFileDownload = null;
                            downloadCancelled = false;
                            document.getElementById('cancel-download-btn').style.display = 'inline-block';
                            break;
                        case 'sftp_download_complete':
                            {
                                console.log('[下载] 收到 complete', msg, '分块数:', window.fileDownloadChunks.length);
                                window.fileDownloadInProgress = false;
                                document.getElementById('cancel-download-btn').style.display = 'none';
                                const totalSize = window.fileDownloadChunks.reduce((s, c) => s + c.byteLength, 0);
                                console.log('[下载] 总大小:', totalSize, '字节');
                                try {
                                    const blob = new Blob(window.fileDownloadChunks, {type: 'application/octet-stream'});
                                    console.log('[下载] Blob 大小:', blob.size);
                                    const url = URL.createObjectURL(blob);
                                    const a = document.createElement('a');
                                    a.href = url;
                                    a.download = msg.fileName;
                                    a.style.display = 'none';
                                    document.body.appendChild(a);
                                    a.click();
                                    setTimeout(() => {
                                        document.body.removeChild(a);
                                        URL.revokeObjectURL(url);
                                    }, 1000);
                                    const statusEl = document.getElementById('status');
                                    if (statusEl) statusEl.textContent = '已连接';
                                } catch (e) {
                                    console.error('[下载] Blob 下载失败:', e);
                                    showAlert('下载完成但保存失败: ' + friendlySFTPError(e.message));
                                }
                                window.fileDownloadChunks = [];
                                window.fileDownloadReceived = 0;
                                window.fileDownloadTotal = 0;
                                window.fileDownloadName = null;
                            }
                            break;
                        case 'sftp_download_error':
                            window.fileDownloadInProgress = false;
                            window.expectedFileDownload = null;
                            window.fileDownloadChunks = [];
                            document.getElementById('cancel-download-btn').style.display = 'none';
                            if (!msg.cancelled) {
                                showAlert('文件下载失败: ' + friendlySFTPError(msg.error));
                            } else {
                                const statusEl = document.getElementById('status');
                                if (statusEl) statusEl.textContent = '已连接';
                            }
                            break;
                        case 'sftp_download_data':
                            // 处理旧版本服务器的base64响应（向后兼容）
                            if (msg.success) {
                                if (msg.fileData) {
                                    // 下载文件（旧版本base64方式）
                                    const byteCharacters = atob(msg.fileData);
                                    const byteNumbers = new Array(byteCharacters.length);
                                    for (let i = 0; i < byteCharacters.length; i++) {
                                        byteNumbers[i] = byteCharacters.charCodeAt(i);
                                    }
                                    const byteArray = new Uint8Array(byteNumbers);
                                    const blob = new Blob([byteArray], {type: 'application/octet-stream'});
                                    const url = URL.createObjectURL(blob);
                                    
                                    const a = document.createElement('a');
                                    a.href = url;
                                    a.download = msg.fileName;
                                    document.body.appendChild(a);
                                    a.click();
                                    document.body.removeChild(a);
                                    URL.revokeObjectURL(url);
                                    
                                    showAlert('文件下载成功: ' + msg.fileName);
                                } else {
                                    // 二进制下载准备中的消息
                                    console.log('等待二进制数据传输...');
                                }
                            } else {
                                showAlert('文件下载失败: ' + friendlySFTPError(msg.error));
                                window.expectedFileDownload = null; // 清除下载标记
                            }
                            break;
                    }
                } catch (e) {
                    console.error('解析消息失败:', e);
                    // 尝试直接将字符串写入终端
                    if (term && term.element) {
                        term.write("\r\n[RAW] " + event.data + "\r\n");
                    }
                }
            } else {
                console.log('Received unknown data type:', typeof event.data);
            }
        };
        
        // 连接关闭事件
        socket.onclose = () => {
            console.log('WebSocket连接已关闭');
            disconnect();
        };
        
        // 连接错误事件
        socket.onerror = (error) => {
            console.error('WebSocket错误:', error);
            document.getElementById('status').innerHTML = '连接错误';
            document.getElementById('status').className = 'status status-disconnected';
        };
    } catch (e) {
        console.error('连接失败:', e);
        showAlert('连接失败: ' + e.message);
    }
}

// 断开连接
function disconnect() {
    if (socket) {
        // 发送断开连接请求
        try {
            socket.send(JSON.stringify({type: 'disconnect'}));
        } catch (e) {
            // 忽略错误
        }
        
        // 关闭WebSocket连接
        socket.close();
        socket = null;
    }
    
    // 更新UI状态
    document.getElementById('status').innerHTML = '未连接';
    document.getElementById('status').className = 'status status-disconnected';
    document.getElementById('connect-btn').disabled = false;
    document.getElementById('disconnect-btn').disabled = true;
    document.getElementById('sftp-controls').style.display = 'none';
    document.getElementById('terminal-keybar').style.display = 'none';
}

// 调整终端大小
function resizeTerminal() {
    if (socket && socket.readyState === WebSocket.OPEN) {
        const resizeMsg = JSON.stringify({
            type: 'resize',
            cols: term.cols,
            rows: term.rows
        });
        socket.send(resizeMsg);
    }
}

// 监听终端数据输入
term.onData((data) => {
    if (socket && socket.readyState === WebSocket.OPEN) {
        const dataMsg = JSON.stringify({
            type: 'data',
            data: data
        });

        socket.send(dataMsg);
    } else {
        console.log('Socket not open, cannot send data');
    }
});

// 页面关闭时断开连接
window.addEventListener('beforeunload', () => {
    disconnect();
});

// 导航到上一级目录
function navigateToParentDirectory() {
    if (!socket || socket.readyState !== WebSocket.OPEN) {
        showAlert('请先连接到SSH服务器');
        return;
    }
    
    const remotePath = document.getElementById('remote-path').value;
    
    // 如果已经是根目录，则不执行任何操作
    if (remotePath === '/' || remotePath === '') {
        return;
    }
    
    // 计算上一级目录路径
    let parentPath;
    if (remotePath.endsWith('/')) {
        parentPath = remotePath.substring(0, remotePath.length - 1);
    } else {
        parentPath = remotePath;
    }
    parentPath = parentPath.substring(0, parentPath.lastIndexOf('/'));
    
    // 确保路径不以空字符串结束
    if (parentPath === '') {
        parentPath = '/';
    }
    
    // 更新路径输入框
    document.getElementById('remote-path').value = parentPath;
    
    // 列出上一级目录的文件
    listRemoteFiles();
}
