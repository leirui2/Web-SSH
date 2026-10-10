# 自研 Web-SSH 服务失败原因总结与重开建议

## 一、现象回顾

自研服务 `ss-terminal-1.0.0.jar`（`smarteyes-webssh.service`）在网页上使用私钥认证时，报错：

text

```
com.jcraft.jsch.JSchException: Auth fail
   at com.jcraft.jsch.Session.connect(Session.java:519)
   at com.ssterminal.config.SSHWebSocketHandler.connectSSH(SSHWebSocketHandler.java:205)
   at com.ssterminal.config.SSHWebSocketHandler.handleTextMessage(SSHWebSocketHandler.java:129)
```



服务端 `/var/log/auth.log` 里**没有任何 `Failed publickey` 记录**，只有：

text

```
Received disconnect from 111.38.183.123 port 39920:3:
   com.jcraft.jsch.JSchException: Auth fail [preauth]
```



说明：**JSch 在客户端侧就失败了，根本没走到服务端公钥认证流程。**

------

## 二、根因分析（按重要性排序）

### 根因 1：JSch 对新式 OpenSSH 私钥格式支持差

- 第一次上传的是 `id_ed25519_jsd_server`（默认格式），文件头：

  text

  ```
  -----BEGIN OPENSSH PRIVATE KEY-----
  ```

  

- 老版本 JSch（0.1.55 及以前）只认 PEM 格式：

  text

  ```
  -----BEGIN RSA PRIVATE KEY-----
  ```

  

- JSch 拿到 OPENSSH 格式私钥时，`KeyPair.load()` 解析失败，但异常处理不完善，最终只抛笼统的 `Auth fail`，掩盖了真实原因（无法解析私钥）。

- 后续换成 PEM 格式 RSA 密钥，但网页表单传输又引入了新问题（见根因 2）。

### 根因 2：网页表单传输私钥时容易损坏内容

私钥是多行文本，包含：

- 首行 `-----BEGIN RSA PRIVATE KEY-----`
- 中间 base64 内容（通常 64 字符换行）
- 尾行 `-----END RSA PRIVATE KEY-----`

网页传输私钥的典型问题：

| 问题                                    | 后果            |
| :-------------------------------------- | :-------------- |
| 表单提交时把多行合并成一行（`\n` 丢失） | JSch 解析失败   |
| 复制时首尾 `-----` 行没带上             | JSch 解析失败   |
| 内容里混入空格/制表符/全角字符          | base64 解码失败 |
| 前端做了 trim/HTML 转义                 | 私钥内容不完整  |
| 通过 WebSocket 分段传输时未正确拼接     | 内容截断        |

由于日志只抛 `Auth fail`（不是 `Invalid key`），私钥解析错误的真实原因被隐藏。

### 根因 3：JSch 版本偏老，算法协商能力弱

自研服务依赖 `com.jcraft.jsch`，很可能是老版本（0.1.5x）。典型问题：

- 默认只用 `ssh-rsa`（SHA-1）签名算法
- 现代 OpenSSH（8.8+，Ubuntu 22.04 自带 9.x）默认禁用 `ssh-rsa`
- 即使服务端临时放开 `PubkeyAcceptedAlgorithms +ssh-rsa`，JSch 也常因 KEX 算法协商失败

**验证方法**：

bash

```
unzip -l ss-terminal-1.0.0.jar | grep -i jsch
```



若显示 `jsch-0.1.55.jar` 或更早，基本确认。

### 根因 4：日志与异常处理不完善

`SSHWebSocketHandler.java:205` 附近可能只有：

java

```
try {
    session.connect();
} catch (JSchException e) {
    log.error("JSchException: " + e.getMessage());
}
```



导致：

- 无法区分“私钥解析失败”和“服务端拒绝认证”
- 看不到 JSch 尝试的算法、用户名、认证方式
- 排查只能靠猜

### 根因 5：连接来源与配置不符（旁证问题）

网页表单填的主机是 `127.0.0.1`，但服务端日志显示连接来源是 `111.38.183.123`。说明：

- 服务端内部可能把 `127.0.0.1` 替换成了公网 IP
- 或 JSch 连接的实际目标不是表单填的地址

这会导致调试误导，说明配置传递链路有 bug。

------

## 三、为什么换成 ttyd 就好了

| 对比项       | ss-terminal (JSch)   | ttyd                         |
| :----------- | :------------------- | :--------------------------- |
| SSH 协议实现 | 纯 Java 重写（JSch） | 直接调用系统 `ssh` 命令      |
| 私钥支持     | 需 JSch 解析         | OpenSSH 原生支持，格式全兼容 |
| 新算法支持   | 依赖 JSch 版本       | 跟随系统 OpenSSH             |
| 上传私钥需求 | 网页上传             | 无需上传，用系统密钥或密码   |
| 代码维护     | 自己维护             | 成熟开源项目                 |

**核心区别**：JSch 是“重新实现 SSH 协议”，ttyd 是“复用系统 SSH”。前者需持续跟进算法演进，后者只做 PTY 转发，几乎不会遇到兼容性问题。

------

## 四、重新开发的建议

### 架构层面

1. **不要自己用 JSch 实现 SSH 协议**，改用：
   - **方案 A（推荐）**：直接调用系统 `ssh` 命令，用 `pty` 转发 I/O（同 ttyd）
   - **方案 B**：Apache MINA SSHD（维护活跃，支持新算法）
   - **方案 C**：sshj（现代 Java SSH 库，支持 ed25519、OpenSSH 格式、新 KEX 算法）
2. **私钥不通过网页上传**，改为：
   - 服务端预置固定密钥文件（推荐）
   - 或使用 SSH Agent 转发
   - 或让用户用账号密码登录（若安全策略允许）

### 安全性层面

1. **禁用密码登录后，web ssh 服务也必须走密钥**：
   - 服务端预置密钥，绑定到运行服务的系统用户
   - web 层做用户身份验证，认证通过后用预置密钥连接本机 sshd
2. **私钥文件权限必须 0600**，否则 OpenSSH 拒绝使用：
   - 若用 JSch/MINA，代码里也要显式设置权限
   - 临时文件用完立即删除
3. **web 服务本身要有认证**：
   - HTTP Basic Auth（简单）
   - 或集成用户系统（JWT / Session）
   - 必须上 HTTPS，否则密码明文传输

### 日志与异常处理

1. **详细记录 JSch/MINA 的异常 cause**：

   java

   ```
   catch (JSchException e) {
       log.error("SSH connect failed: {}", e.getMessage(), e);
       if (e.getCause() != null) {
           log.error("Cause: {}", e.getCause().getMessage(), e.getCause());
       }
   }
   ```

   

2. **记录关键认证阶段**：

   - 私钥加载是否成功
   - 服务端支持的认证方式
   - 协商的算法

3. **前端把私钥内容做 base64 或 JSON 数组传输**，避免多行文本被吃掉换行。

### 配置传递

1. **表单里的主机、端口、用户名要在服务端日志里明确打印**，确认接收值就是用户填的。
2. **不要静默替换地址**，行为要可预期。

------

## 五、短平快需求：直接跳过自研

若只是想让网页版能连 SSH，**不要重新开发**，直接用现成方案：

| 方案                      | 特点                                       |
| :------------------------ | :----------------------------------------- |
| **ttyd**                  | 最简单，直接跑系统命令，无兼容性问题       |
| **gotty**                 | 类似 ttyd，Go 语言实现                     |
| **webssh (Python)**       | Python 版，支持私钥上传（后端用 paramiko） |
| **Apache Guacamole**      | 功能最全，支持 RDP/VNC/SSH，适合企业       |
| **JumpServer / Teleport** | 堡垒机，支持审计、录像                     |

**自研 web-ssh 性价比很低**：

- 安全审计、录像、多用户管理都要自己实现
- SSH 协议兼容性、密钥格式、算法演进都要持续跟进
- 开源方案已经非常成熟

------

## 六、本次事件时间线（供复盘）

| 时间                | 事件                                                         |
| :------------------ | :----------------------------------------------------------- |
| 9月28日 21:48       | 攻击者通过暴露的 PostgreSQL（0.0.0.0:54321，弱密码 123456）进入数据库，创建 `wog` 超级用户、`escalate_priv()` 事件触发器后门 |
| 9月29日 19:06       | 攻击者继续在数据库里活动                                     |
| 9月29日 23:21-23:59 | 攻击者从腾讯云 IP（81.71.18.205、106.52.38.125）SSH 登录服务器 20+ 次 |
| 10月8日             | 重启服务器后，应用连不上数据库，发现密码错误 → 后门显现      |
| 10月9日             | 数据库 `postgres` 被禁登录，反复修复又复发                   |
| 10月10日            | 抓出根因：数据库事件触发器 + SSH 密码登录被爆破 + 自研 web-ssh 用 JSch 兼容性差 |

------

## 七、行动清单（结项）

**已完成**：

- ✅ 数据库后门清理（`wog` / `escalate_priv` / 事件触发器 / `postgres_fdw`）
- ✅ 数据库不再暴露公网（54321 只监听 127.0.0.1）
- ✅ SSH 密码登录已禁用（只允许公钥）
- ✅ fail2ban 已配置（普通爆破封 4 周，惯犯永久封）
- ✅ ttyd 替代方案已部署

**待后续处理**：

- 🔲 重写 web-ssh（或用 ttyd 长期替代）
- 🔲 改所有相关密码（jsd、postgres、应用配置）
- 🔲 若确认攻击者拿到过 shell，考虑重装系统
- 🔲 检查其他暴露公网的服务（Redis、pgAdmin 等）是否也要收紧

------

**一句话总结**：本次 web-ssh 失败的根本原因是 **用 JSch 实现 SSH 协议，而 JSch 对新式私钥格式和现代 SSH 算法支持差，且异常处理掩盖了真实错误**。重新开发时，要么改用 Apache MINA SSHD / sshj，要么直接调用系统 ssh（ttyd 方式），并完善日志和异常处理。如果只是要功能，直接用 ttyd 最省事。