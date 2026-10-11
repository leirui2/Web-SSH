# Web-SSH — Web SSH 终端与 SFTP 文件管理服务

基于 Spring Boot + WebSocket + xterm.js + JSch 的浏览器 SSH 客户端：在网页里连接远程服务器、使用交互式终端，并内置 SFTP 文件管理（流式上传/下载、断点续传、MD5 校验）。可选开启网页登录鉴权，配合登录失败 IP 永久封禁。

## 技术栈

| 组件 | 版本 | 说明 |
|:---|:---|:---|
| Java | 21 | 运行环境 |
| Spring Boot | 3.4.5 | Web / WebSocket / Thymeleaf |
| JSch (mwiede fork) | 2.28.7 | SSH/SFTP 客户端，支持 ed25519、OpenSSH 私钥格式 |
| xterm.js | 5.5.0 | 前端终端模拟器 |
| Maven | 3.9.16 | 构建工具 |

## 功能特性

### SSH 终端
- 浏览器内完整终端体验（xterm.js），`resize` 自适应
- 密码认证 / 私钥认证（支持上传或粘贴私钥，兼容 ed25519）
- 鼠标拖拽选择自动复制，`Ctrl+Shift+C` 复制 / `Ctrl+Shift+V` 粘贴
- 连接状态实时显示（连接中 / 已连接 / 连接失败）

### SFTP 文件管理
- **流式上传**：分片直写远程文件（SFTP OutputStream），不落本地临时文件
- **流式下载**：后端分块发送，前端 Blob 拼接保存
- **断点续传**：重传时自动检测远程已有部分，APPEND 续写
- **MD5 校验**：上传完成对比本地 / 远程 MD5
- **多文件批量上传**：队列依次处理，每个文件独立断点续传
- **拖拽上传**：拖文件到 SFTP 区域直接上传
- **传输取消**：上传 / 下载过程中可取消
- **实时速度**：显示 MB/s 与剩余时间
- **文件列表增强**：表头排序、搜索过滤、权限 / 时间戳显示

### 服务器配置与快捷命令
- 服务器配置管理页面：多服务器保存 / 编辑 / 删除 / 搜索
- 快捷命令分组：增删改查，内置 Linux / Docker 默认组

### 登录鉴权与 IP 封禁（可开关）
- 网页登录页 + 服务端会话鉴权，页面 / REST / WebSocket 全部拦截
- 登录失败累计达阈值后**永久封禁该 IP**（整站拒绝），名单持久化到文件，重启不清零
- 关闭开关后与未接入鉴权时行为完全一致

## 项目结构

```
src/main/java/com/web_ssh/
├── WebSSHApplication.java                 # 启动类
├── config/
│   ├── SSHWebSocketHandler.java           # 核心：WebSocket 处理器（SSH 终端 + SFTP 上传/下载）
│   ├── WebSocketConfig.java               # WebSocket 配置（同源校验、消息大小）
│   ├── WebMvcConfig.java                  # 静态资源配置
│   ├── AuthProperties.java                # 鉴权配置绑定
│   ├── AuthFilter.java                    # 鉴权过滤器（封禁拦截 + 会话校验）
│   ├── FilterConfig.java                  # 过滤器注册
│   ├── LoginAttemptService.java           # 失败计数 + 持久化封禁
│   └── ClientIpUtils.java                 # 客户端 IP 解析
├── controller/
│   ├── SSHController.java                 # 页面路由
│   ├── LoginController.java               # 登录 / 登出
│   ├── SSHServerConfigController.java     # 服务器配置 CRUD API
│   └── TerminalKeyGroupController.java    # 快捷命令分组 CRUD API
├── model/
│   ├── SSHServerConfig.java               # 服务器配置实体
│   └── TerminalKeyGroup.java              # 快捷命令分组实体
└── service/
    ├── SSHServerConfigService.java        # 服务器配置服务
    └── TerminalKeyGroupService.java       # 快捷命令分组服务

src/main/resources/
├── application.properties
├── templates/
│   ├── login.html                         # 登录页
│   ├── ssh-client.html                    # SSH 终端页面
│   └── ssh-server-config.html             # 服务器配置管理页面
└── static/
    ├── css/xterm.css
    └── js/ssh-client.js                   # 前端核心逻辑
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

浏览器访问（默认端口 8066）：
- 终端：`http://localhost:8066/ssh-client`
- 服务器配置：`http://localhost:8066/ssh-server-config`

> `server.port` 与端口可通过 `application.properties` 调整。

## 配置说明（application.properties）

| 配置项 | 默认值 | 说明 |
|:---|:---|:---|
| `server.port` | `8066` | 服务端口 |
| `spring.thymeleaf.cache` | `false` | 模板缓存，生产建议改 `true` |
| `spring.servlet.multipart.max-file-size` | `500MB` | 单文件上传上限 |
| `spring.servlet.multipart.max-request-size` | `500MB` | 单请求上传上限 |
| `spring.jackson.time-zone` | `GMT+8` | 时区 |
| `webssh.auth.enabled` | `false` | 是否开启网页登录鉴权 |
| `webssh.auth.username` | `admin` | 登录用户名 |
| `webssh.auth.password` | （空） | 登录密码 |
| `webssh.auth.max-fail-count` | `5` | 登录失败次数上限，达到即永久封禁该 IP |
| `webssh.auth.lock-seconds` | `0` | 失败计数重置窗口（秒）；`0` = 永久累计（推荐） |
| `webssh.auth.trust-proxy-headers` | `false` | 是否信任 `X-Forwarded-For`/`X-Real-IP`；无反代保持 `false` |
| `webssh.auth.block-file` | `./data/webssh-blocked-ips.json` | 封禁名单持久化文件 |

多环境可用 `application-prod.properties` 覆盖（配合 `SPRING_PROFILES_ACTIVE=prod`）。

## 登录鉴权与 IP 封禁

开启方式：`webssh.auth.enabled=true`，并设置 `webssh.auth.username` / `webssh.auth.password`。

- **鉴权范围**：除 `/login`、`/logout` 与 `/css/**`、`/js/**` 静态资源外，页面、REST 接口与 WebSocket `/ssh-connect` 均需先登录。
- **失败封禁**：同一 IP 登录失败累计达 `max-fail-count` 次后**永久封禁**，写入 `block-file`，服务重启后自动加载仍生效；被封 IP 访问任何请求返回 `403`。
- **一次成功登录**会清零该 IP 的失败计数。
- **开关关闭**（`enabled=false`）时：不做鉴权、不计失败、不封禁，页面也不显示登出按钮。

### 封禁文件格式
```json
{
  "blockedIps" : { "203.0.113.5" : 1712345678901 },
  "attempts"   : { "198.51.100.7" : { "failCount" : 2, "lastFailTime" : 1712345678000 } }
}
```

### 解封步骤
```bash
vi /path/to/data/webssh-blocked-ips.json   # 删除对应 IP，或直接删除整个文件
systemctl restart <服务名>
```
> 名单仅在启动时加载，运行中修改文件不会热生效，需重启。

## 部署（systemd 示例）

```ini
[Unit]
Description=Web SSH
After=network.target
Requires=network.target

[Service]
Type=simple
WorkingDirectory=/home/jsd/web-ssh
ExecStart=/usr/bin/java -jar ss-terminal-1.0.0.jar
Restart=on-failure
RestartSec=3

[Install]
WantedBy=multi-user.target
```

**数据文件路径**：`ssh_server_configs.json`、`terminal_key_groups.json`、`data/webssh-blocked-ips.json` 均按**进程工作目录**（`WorkingDirectory`）解析，运行时应确保该目录对运行账号可写。启动日志会打印封禁文件的**绝对路径**，可用于确认：
```
[Auth] 封禁文件路径: /home/jsd/web-ssh/data/webssh-blocked-ips.json
```

## HTTP 接口

| 方法 | 路径 | 说明 |
|:---|:---|:---|
| GET | `/` | 跳转 `/ssh-client` |
| GET | `/ssh-client` | SSH 终端页面 |
| GET | `/ssh-server-config` | 服务器配置页面 |
| GET / POST | `/login` | 登录页 / 提交登录 |
| GET | `/logout` | 登出 |
| GET | `/api/ssh-servers` | 服务器配置列表 |
| GET | `/api/ssh-servers/{id}` | 单个配置 |
| POST | `/api/ssh-servers` | 新增配置 |
| PUT | `/api/ssh-servers/{id}` | 更新配置 |
| DELETE | `/api/ssh-servers/{id}` | 删除配置 |
| GET | `/api/ssh-servers/search?keyword=` | 搜索配置 |
| GET / POST | `/api/terminal-key-groups` | 按键组列表 / 新增 |
| GET / PUT / DELETE | `/api/terminal-key-groups/{id}` | 按键组查询 / 更新 / 删除 |

## WebSocket 消息协议

端点：`/ssh-connect`（JSON 文本消息，上传/下载分片走二进制帧）。

### 客户端 → 服务端
| type | 说明 |
|:---|:---|
| `connect` | 建立 SSH 连接（host / port / username / auth） |
| `data` | 终端输入 |
| `resize` | 终端尺寸变更（cols / rows） |
| `disconnect` | 断开连接 |
| `sftp_list` | 列出目录 |
| `sftp_upload` | 上传请求（文件名 / 大小 / 远程路径） |
| `sftp_data` | 上传分片元数据（随后跟二进制分片） |
| `sftp_upload_cancel` | 取消上传 |
| `sftp_download` | 下载请求 |
| `sftp_download_cancel` | 取消下载 |

### 服务端 → 客户端
| type | 说明 |
|:---|:---|
| `connect` | 连接结果 |
| `output` | 终端输出 |
| `error` | 错误信息 |
| `sftp_list_result` | 目录列表结果 |
| `sftp_upload_start` | 上传开始 |
| `sftp_upload_ready` | 上传就绪（含远程已有大小，用于续传） |
| `sftp_chunk_received` | 分片接收确认 |
| `sftp_upload_result` | 上传完成（localMd5 / remoteMd5 / md5Match） |
| `sftp_download_start` | 下载开始（fileSize） |
| `sftp_download_complete` | 下载完成 |
| `sftp_download_error` | 下载错误（含 cancelled 标志） |

## 关键实现

### 流式直写远程上传
使用 `ChannelSftp.put(fileName, mode)` 返回的 SFTP OutputStream 直接写入远程文件，分片到达即写入，无需本地临时文件。重传时 `stat` 检查远程已有大小决定续写偏移（APPEND）。

### 增量 MD5 计算
每片写入时 `MessageDigest.update()`，最后 `digest()` 得到完整文件 MD5；续传时先读取远程已有部分更新摘要，确保本地 MD5 覆盖整个文件。

### 下载独立线程
下载在独立线程执行 `channel.get()`，主线程可接收取消消息，通过取消标志在中途中断。

## 安全说明

- **网页鉴权 + IP 永久封禁**：应用层防护，需 `webssh.auth.enabled=true` 才生效；封禁按客户端 IP，换 IP 无法覆盖。
- **WebSocket 同源校验**：`/ssh-connect` 仅允许同源握手，防止跨站 WebSocket 劫持（CSWSH）。
- **无内置 HTTPS**：浏览器与 8066 之间为明文，登录口令、私钥、终端内容可被同网段嗅探。建议仅在受信网络部署，或前置反向代理启用 TLS（此时把 `trust-proxy-headers` 设为 `true`）。
- **SSH 主机密钥未校验**：SSH/SFTP 连接使用 `StrictHostKeyChecking=no`，存在中间人（MITM）风险。
- **服务器配置明文存储**：`ssh_server_configs.json` 中的密码为明文，且 `/api/ssh-servers` 会返回给前端，注意文件权限与访问控制。
- **高权限入口**：登录后可在网页连接任意主机，属于高权限通道，务必通过防火墙 / 网络隔离限制 8066 的访问来源。
