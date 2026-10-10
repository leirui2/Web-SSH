# Web-SSH — Web SSH 终端与 SFTP 文件管理服务

基于 Spring Boot + WebSocket + xterm.js + JSch 的 Web SSH 终端，内置 SFTP 文件管理（流式上传/下载、断点续传、MD5 校验）。

## 技术栈

| 组件 | 版本 | 说明 |
|:---|:---|:---|
| Java | 21 | 运行环境 |
| Spring Boot | 3.4.5 | Web 框架 |
| JSch (mwiede fork) | 2.28.7 | SSH/SFTP 客户端，支持 ed25519、OpenSSH 私钥格式 |
| xterm.js | 5.5.0 | 前端终端模拟器（官方版） |
| WebSocket | - | 终端 + 文件传输通信通道 |
| Maven | 3.9.16 | 构建工具 |

## 功能特性

### SSH 终端
- 浏览器内完整终端体验（xterm.js）
- 鼠标拖拽选择自动复制，`Ctrl+Shift+C` 复制 / `Ctrl+Shift+V` 粘贴
- 快捷命令分组管理（增删改查，持久化到服务端）
- 服务器配置管理页面（多服务器保存/编辑/删除/搜索）
- 连接状态实时显示（连接中 / 已连接 / 连接失败）

### SFTP 文件管理
- **流式上传**：分片直写远程文件（SFTP OutputStream），不经过本地临时文件
- **流式下载**：后端 256KB 分块流式发送，前端 Blob 拼接保存
- **断点续传**：中途断开后重新上传，自动检测远程已有部分，从断点继续（APPEND 模式）
- **MD5 校验**：上传完成后对比本地/远程 MD5，验证文件完整性
- **多文件批量上传**：队列依次处理，每个文件独立断点续传
- **拖拽上传**：拖文件到 SFTP 区域直接上传，支持文件夹递归
- **传输取消**：上传/下载过程中可点取消中止操作
- **实时速度显示**：传输时显示 MB/s 和剩余时间
- **文件列表增强**：表头点击排序、搜索框实时过滤、权限/时间戳显示

### UI
- 自定义弹窗替代浏览器原生 `alert` / `confirm`
- 点击遮罩层空白区域 / ESC 键 / × 按钮关闭弹窗
- 淡入动画 + 圆角阴影卡片样式

## 项目结构

```
src/main/java/com/web_ssh/
├── WebSSHApplication.java              # 启动类
├── config/
│   ├── SSHWebSocketHandler.java        # 核心：WebSocket 处理器（SSH 终端 + SFTP 上传/下载）
│   ├── WebSocketConfig.java            # WebSocket 配置（10MB 消息限制）
│   └── WebMvcConfig.java               # MVC 配置
├── controller/
│   ├── SSHController.java              # 页面路由
│   ├── SSHServerConfigController.java  # 服务器配置 CRUD API
│   └── TerminalKeyGroupController.java # 快捷命令分组 CRUD API
├── model/
│   ├── SSHServerConfig.java            # 服务器配置实体
│   └── TerminalKeyGroup.java           # 快捷命令分组实体
└── service/
    ├── SSHServerConfigService.java     # 服务器配置服务
    └── TerminalKeyGroupService.java    # 快捷命令分组服务

src/main/resources/
├── templates/
│   ├── ssh-client.html                 # SSH 终端页面
│   └── ssh-server-config.html          # 服务器配置管理页面
└── static/
    ├── css/xterm.css                   # xterm 终端样式
    └── js/ssh-client.js                # 前端核心逻辑
```

## 快速开始

### 环境要求
- JDK 21+
- Maven 3.9+

### 构建与运行
```bash
mvn clean package
java -jar target/web-ssh-0.0.1-SNAPSHOT.jar
```

浏览器访问 `http://localhost:8066/ssh-client`

### 配置
- 服务器配置文件：`ssh_server_configs.json`（运行时自动生成）
- 快捷命令分组：`terminal_key_groups.json`（运行时自动生成）

## WebSocket 消息协议

### 终端
| 消息类型 | 方向 | 说明 |
|:---|:---|:---|
| `ssh_connect` | C→S | SSH 连接请求（host/port/username/authType） |
| `connect` | S→C | 连接结果（success/fail） |
| `ssh_data` | C→S | 终端输入数据 |
| `terminal_output` | S→C | 终端输出数据 |
| `ssh_disconnect` | C→S | 断开连接 |

### SFTP
| 消息类型 | 方向 | 说明 |
|:---|:---|:---|
| `sftp_list` | C→S | 列出目录文件 |
| `sftp_list_result` | S→C | 文件列表结果 |
| `sftp_upload` | C→S | 上传请求（文件名/大小/远程路径） |
| `sftp_upload_ready` | S→C | 上传就绪（含 remoteExistingSize 用于断点续传） |
| `sftp_data` | C→S | 上传分片元数据（binaryTransfer=true） |
| Binary Message | C→S | 上传分片二进制数据 |
| `sftp_chunk_received` | S→C | 分片接收确认 |
| `sftp_upload_result` | S→C | 上传完成（含 localMd5/remoteMd5/md5Match） |
| `sftp_upload_cancel` | C→S | 取消上传 |
| `sftp_download` | C→S | 下载请求 |
| `sftp_download_start` | S→C | 下载开始（含 fileSize） |
| Binary Message | S→C | 下载分块二进制数据 |
| `sftp_download_complete` | S→C | 下载完成 |
| `sftp_download_cancel` | C→S | 取消下载 |
| `sftp_download_error` | S→C | 下载错误（含 cancelled 标志） |

## 关键实现

### 流式直写远程上传
使用 `ChannelSftp.put(fileName, mode)` 返回的 SFTP OutputStream 直接写入远程文件，每个分片到达即写入远程，无需本地临时文件。中途断开远程已有部分文件，重连后 `stat` 检查大小决定续传偏移。

### 增量 MD5 计算
使用 `java.security.MessageDigest` 在每个分片写入时 `update(fileData)`，最终 `digest()` 得到完整文件 MD5。续传时先读取远程已有部分更新摘要，确保本地 MD5 覆盖整个文件。

### 下载独立线程
下载在独立线程中执行 `channel.get()`，使 WebSocket 主线程可接收取消消息。OutputStream 的 `flushChunk` 检查取消标志，实现中途取消。
