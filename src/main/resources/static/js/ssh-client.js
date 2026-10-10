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
function initSFTPControls() {
    // 文件列表按钮事件
    document.getElementById('list-files-btn').addEventListener('click', listRemoteFiles);
    
    // 文件上传按钮事件
    document.getElementById('upload-btn').addEventListener('click', () => {
        document.getElementById('file-upload').click();
    });
    
    // 文件选择事件
    document.getElementById('file-upload').addEventListener('change', handleFileUpload);
    
    // 文件下载按钮事件
    document.getElementById('download-btn').addEventListener('click', downloadFile);
    
    // 返回上一级目录按钮事件
    document.getElementById('parent-dir-btn').addEventListener('click', navigateToParentDirectory);
}

// 显示文件列表
function displayFileList(files) {
    const fileListElement = document.getElementById('file-list');
    fileListElement.innerHTML = '';
    
    if (!files || files.length === 0) {
        fileListElement.innerHTML = '<p>目录为空</p>';
        return;
    }
    
    const table = document.createElement('table');
    table.style.width = '100%';
    table.style.borderCollapse = 'collapse';
    
    // 添加表头
    const thead = document.createElement('thead');
    const headerRow = document.createElement('tr');
    const headers = ['文件名', '类型', '大小', '权限', '修改时间'];
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
    
    // 添加文件列表
    const tbody = document.createElement('tbody');
    files.forEach(file => {
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
        alert('请先连接到SSH服务器');
        return;
    }
    
    const remotePath = document.getElementById('remote-path').value || '/';
    const msg = JSON.stringify({
        type: 'sftp_list',
        path: remotePath
    });
    socket.send(msg);
}

// 处理文件上传
function handleFileUpload(event) {
    if (!socket || socket.readyState !== WebSocket.OPEN) {
        alert('请先连接到SSH服务器');
        return;
    }
    
    const file = event.target.files[0];
    if (!file) return;
    
    // 检查文件大小，调整分片大小
    const MAX_CHUNK_SIZE = 2 * 1024 * 1024; // 2MB分片大小，提高上传速度
    const PARALLEL_UPLOADS = 3; // 并行上传数
    
    const remotePath = document.getElementById('remote-path').value || '/';
    const remoteFileName = file.name;
    
    // 创建进度显示元素
    const progressDiv = document.createElement('div');
    progressDiv.id = 'upload-progress';
    progressDiv.style.margin = '10px 0';
    progressDiv.innerHTML = `<strong>上传进度:</strong> <span id="progress-text">准备中...</span>
                            <div style="width:100%; background:#eee; height:20px; margin-top:5px;">
                                <div id="progress-bar" style="width:0%; background:#4CAF50; height:20px;"></div>
                            </div>`;
    
    // 添加到页面
    const sftpControls = document.getElementById('sftp-controls');
    // 移除可能存在的旧进度条
    const oldProgress = document.getElementById('upload-progress');
    if (oldProgress) {
        oldProgress.remove();
    }
    sftpControls.appendChild(progressDiv);
    
    const progressText = document.getElementById('progress-text');
    const progressBar = document.getElementById('progress-bar');
    
    // 更新进度的函数
    const updateProgress = (current, total) => {
        const percent = Math.round((current / total) * 100);
        progressText.textContent = `${percent}% (${current}/${total})`;
        progressBar.style.width = `${percent}%`;
    };
    
    // 发送上传请求
    try {
        const msg = JSON.stringify({
            type: 'sftp_upload',
            remotePath: remotePath,
            fileName: remoteFileName,
            fileSize: file.size
        });
        socket.send(msg);
        progressText.textContent = '服务器准备中...';
    } catch (e) {
        console.error('发送上传请求失败:', e);
        progressText.textContent = '上传请求失败: ' + e.message;
        return;
    }
    
    // 读取文件并发送数据
    const reader = new FileReader();
    reader.onload = function(e) {
        try {
            const fileData = e.target.result;
            const fileArray = new Uint8Array(fileData);
            
            // 如果文件小于分片大小，直接发送
            if (fileArray.length <= MAX_CHUNK_SIZE) {
                progressText.textContent = '正在上传小文件...';
                
                // 等待服务器准备就绪后发送文件数据
                setTimeout(() => {
                    try {
                        // 直接发送二进制数据
                        const dataMsg = {
                            type: 'sftp_data',
                            fileName: remoteFileName,
                            remotePath: remotePath,
                            isLastChunk: true,
                            binaryTransfer: true
                        };
                        
                        // 先发送元数据
                        socket.send(JSON.stringify(dataMsg));
                        
                        // 然后直接发送二进制数据
                        socket.send(fileArray.buffer);
                        progressText.textContent = '文件已发送，等待服务器处理...';
                        console.log('文件上传请求已发送');
                    } catch (e) {
                        console.error('发送文件数据失败:', e);
                        progressText.textContent = '上传失败: ' + e.message;
                    }
                }, 500);
            } else {
                // 大文件分片上传
                const totalChunks = Math.ceil(fileArray.length / MAX_CHUNK_SIZE);
                console.log(`文件大小: ${fileArray.length} 字节, 分为 ${totalChunks} 个分片上传`);
                progressText.textContent = `准备分片上传，共 ${totalChunks} 个分片`;
                
                // 分片上传函数
                const uploadChunk = (chunkIndex) => {
                    if (chunkIndex >= totalChunks) {
                        console.log('所有分片上传完成');
                        progressText.textContent = '所有分片已发送，等待服务器处理...';
                        return;
                    }
                    
                    if (socket.readyState !== WebSocket.OPEN) {
                        console.error('WebSocket连接已关闭，无法继续上传');
                        progressText.textContent = 'WebSocket连接已关闭，上传中断';
                        return;
                    }
                    
                    const start = chunkIndex * MAX_CHUNK_SIZE;
                    const end = Math.min(start + MAX_CHUNK_SIZE, fileArray.length);
                    const chunk = fileArray.slice(start, end);
                    
                    try {
                        // 直接发送二进制数据
                        const dataMsg = {
                            type: 'sftp_data',
                            fileName: remoteFileName,
                            remotePath: remotePath,
                            chunkIndex: chunkIndex,
                            totalChunks: totalChunks,
                            isLastChunk: (chunkIndex === totalChunks - 1),
                            binaryTransfer: true
                        };
                        
                        // 先发送元数据
                        socket.send(JSON.stringify(dataMsg));
                        
                        // 然后直接发送二进制数据块
                        socket.send(chunk.buffer);
                        updateProgress(chunkIndex + 1, totalChunks);
                        console.log(`已发送分片 ${chunkIndex + 1}/${totalChunks}`);
                        
                        // 增加延迟时间，给服务器更多处理时间
                        setTimeout(() => {
                            uploadChunk(chunkIndex + 1);
                        }, 500);
                    } catch (e) {
                        console.error(`分片 ${chunkIndex + 1} 上传失败:`, e);
                        progressText.textContent = `分片 ${chunkIndex + 1} 上传失败: ${e.message}`;
                    }
                };
                
                // 开始上传第一个分片
                setTimeout(() => {
                    uploadChunk(0);
                }, 500);
            }
        } catch (e) {
            console.error('处理文件数据失败:', e);
            progressText.textContent = '处理文件数据失败: ' + e.message;
        }
    };
    
    reader.onerror = function(e) {
        console.error('读取文件失败:', e);
        if (progressText) {
            progressText.textContent = '读取文件失败: ' + e.target.error;
        }
    };
    
    try {
        reader.readAsArrayBuffer(file);
    } catch (e) {
        console.error('启动文件读取失败:', e);
        progressText.textContent = '启动文件读取失败: ' + e.message;
    }
    
    // 清空文件选择器，允许重复选择同一文件
    document.getElementById('file-upload').value = '';
}

// 下载文件
function downloadFile() {
    if (!socket || socket.readyState !== WebSocket.OPEN) {
        alert('请先连接到SSH服务器');
        return;
    }
    
    const remotePath = document.getElementById('remote-path').value || '/';
    const fileName = document.getElementById('local-file-path').value;
    
    if (!fileName) {
        alert('请输入要下载的文件名');
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
                alert('请先连接到SSH服务器');
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
        alert('请先选择或创建一个按键组');
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
        alert('请先选择或创建一个按键组');
        return;
    }
    
    const keyId = document.getElementById('key-edit-id').value;
    const keyLabel = document.getElementById('key-edit-label').value.trim();
    const keyCommand = document.getElementById('key-edit-command').value;
    const keyColor = document.getElementById('key-edit-color').value;
    
    if (!keyLabel || !keyCommand) {
        alert('请填写有效的按键标签和命令');
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
            alert('保存按键失败: ' + error.message);
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
    
    if (!confirm('确定要删除这个按键吗？')) {
        return;
    }
    
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
            alert('删除按键失败: ' + error.message);
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
        alert('请先选择一个按键组');
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
        alert('请填写有效的按键组名称');
        return;
    }
    
    console.log('正在保存按键组:', groupName, 'ID:', groupId || '新按键组');
    
    let keyGroup;
    let isNewGroup = false;
    
    if (groupId) {
        // 更新现有按键组
        keyGroup = keyGroups.find(group => group.id === groupId);
        if (!keyGroup) {
            alert('错误: 找不到要更新的按键组');
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
            alert('保存按键组失败: ' + error.message);
        });
}

// 删除按键组
function deleteKeyGroup() {
    const groupId = document.getElementById('group-edit-id').value;
    if (!groupId) {
        return;
    }
    
    if (!confirm('确定要删除这个按键组吗？')) {
        return;
    }
    
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
        alert('删除按键组失败: ' + error.message);
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
        alert('请填写主机和用户名');
        return;
    }
    
    let authData = {};
    if (authMethod === 'password') {
        const password = document.getElementById('password').value;
        if (!password) {
            alert('请填写密码');
            return;
        }
        authData = {
            type: 'password',
            password: password
        };
    } else {
        const privateKey = document.getElementById('private-key').value.trim();
        if (!privateKey) {
            alert('请提供私钥内容');
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
            document.getElementById('status').innerHTML = '已连接到 ' + host;
            document.getElementById('status').className = 'status status-connected';
            document.getElementById('connect-btn').disabled = true;
            document.getElementById('disconnect-btn').disabled = false;
            document.getElementById('sftp-controls').style.display = 'block';
            document.getElementById('terminal-keybar').style.display = 'block';
            
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
                    const statusEl = document.getElementById('status');
                    if (statusEl) {
                        statusEl.textContent = `下载中 ${window.fileDownloadName}: ${progress}% (${(window.fileDownloadReceived/1024/1024).toFixed(1)}MB / ${(window.fileDownloadTotal/1024/1024).toFixed(1)}MB)`;
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
                    
                    alert('文件下载成功: ' + window.expectedFileDownload);
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
                        case 'error':
                            term.write("\r\n[ERROR] " + msg.message + "\r\n");
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
                        case 'sftp_upload_result':
                            if (msg.success) {
                                let alertMsg = '文件上传成功: ' + msg.fileName;
                                if (msg.localMd5 && msg.remoteMd5) {
                                    alertMsg += '\n\n本地 MD5:  ' + msg.localMd5;
                                    alertMsg += '\n远程 MD5:  ' + msg.remoteMd5;
                                    alertMsg += '\nMD5 校验:  ' + (msg.md5Match ? '✅ 一致' : '❌ 不一致');
                                }
                                alert(alertMsg);
                            } else {
                                alert('文件上传失败: ' + (msg.error || '未知错误'));
                            }
                            break;
                        case 'sftp_download_start':
                            console.log('[下载] 收到 sftp_download_start', msg);
                            window.fileDownloadInProgress = true;
                            window.fileDownloadChunks = [];
                            window.fileDownloadReceived = 0;
                            window.fileDownloadTotal = msg.fileSize;
                            window.fileDownloadName = msg.fileName;
                            window.expectedFileDownload = null;
                            break;
                        case 'sftp_download_complete':
                            {
                                console.log('[下载] 收到 complete', msg, '分块数:', window.fileDownloadChunks.length);
                                window.fileDownloadInProgress = false;
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
                                    alert('下载完成但保存失败: ' + e.message + '\n文件大小: ' + totalSize + ' 字节');
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
                            alert('文件下载失败: ' + (msg.error || '未知错误'));
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
                                    
                                    alert('文件下载成功: ' + msg.fileName);
                                } else {
                                    // 二进制下载准备中的消息
                                    console.log('等待二进制数据传输...');
                                }
                            } else {
                                alert('文件下载失败: ' + (msg.error || '未知错误'));
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
        alert('连接失败: ' + e.message);
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
        alert('请先连接到SSH服务器');
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
