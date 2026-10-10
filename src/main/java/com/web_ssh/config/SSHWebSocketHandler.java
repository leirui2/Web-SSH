package com.web_ssh.config;

import com.jcraft.jsch.Channel;
import com.jcraft.jsch.ChannelShell;
import com.jcraft.jsch.JSch;
import com.jcraft.jsch.JSchException;
import com.jcraft.jsch.Session;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.springframework.web.socket.BinaryMessage;
import org.springframework.web.socket.TextMessage;
import org.springframework.web.socket.WebSocketSession;
import org.springframework.web.socket.handler.TextWebSocketHandler;
import org.springframework.web.socket.CloseStatus;

import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.util.Collections;
import java.util.HashSet;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import com.jcraft.jsch.ChannelSftp;
import com.jcraft.jsch.SftpATTRS;
import com.jcraft.jsch.SftpException;
import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Base64;

/**
 * SSH 远程终端 + SFTP 文件管理器。
 */
public class SSHWebSocketHandler extends TextWebSocketHandler {
    // 用于存储二进制上传数据的临时存储
    private ConcurrentHashMap<String, ByteArrayOutputStream> binaryUploads = new ConcurrentHashMap<>();
    
    // 存储当前正在处理的二进制上传信息
    private ConcurrentHashMap<String, Map<String, Object>> pendingBinaryUploads = new ConcurrentHashMap<>();
    
    // 存储当前正在处理的二进制下载信息
    private ConcurrentHashMap<String, Map<String, Object>> pendingBinaryDownloads = new ConcurrentHashMap<>();
    
    // 存储SSH会话
    private ConcurrentHashMap<String, Session> sshSessions = new ConcurrentHashMap<>();
    // 存储SSH通道
    private ConcurrentHashMap<String, ChannelShell> sshChannels = new ConcurrentHashMap<>();
    // 存储SSH输出流
    private ConcurrentHashMap<String, OutputStream> sshOutputStreams = new ConcurrentHashMap<>();
    // 存储WebSocket会话
    private Set<WebSocketSession> webSocketSessions = Collections.synchronizedSet(new HashSet<>());
    // 存储SFTP通道
    private ConcurrentHashMap<String, ChannelSftp> sftpChannels = new ConcurrentHashMap<>();
    
    // 重写afterConnectionEstablished方法，记录新建立的WebSocket会话
    @Override
    public void afterConnectionEstablished(WebSocketSession session) throws Exception {
        super.afterConnectionEstablished(session);
        
        // 设置WebSocket会话属性，增加缓冲区大小和超时时间
        try {
            // 尝试设置更大的文本消息缓冲区大小（如果支持）
            session.setTextMessageSizeLimit(1024 * 1024 * 10); // 10MB
            session.setBinaryMessageSizeLimit(1024 * 1024 * 10); // 10MB
            
            // 设置会话超时时间（如果支持）
            if (session.getAttributes() != null) {
                session.getAttributes().put("timeout", 300000); // 5分钟超时
            }
        } catch (Exception e) {
            System.err.println("设置WebSocket会话属性失败: " + e.getMessage());
        }
        
        webSocketSessions.add(session);
        System.out.println("WebSocket connection established, sessionId: " + session.getId());
    }
    
    // 重写afterConnectionClosed方法，清理断开的WebSocket会话
    @Override
    public void afterConnectionClosed(WebSocketSession session, CloseStatus status) throws Exception {
        super.afterConnectionClosed(session, status);
        String sessionId = session.getId();
        webSocketSessions.remove(session);
        
        // 关闭SFTP通道
        ChannelSftp sftpChannel = sftpChannels.remove(sessionId);
        if (sftpChannel != null) {
            sftpChannel.disconnect();
        }
        
        // 清理临时上传文件和 SFTP 上传流
        for (String key : tempUploadFiles.keySet()) {
            if (key.startsWith(sessionId + "_")) {
                cleanupTempUpload(key);
            }
        }
        for (String key : sftpUploadStreams.keySet()) {
            if (key.startsWith(sessionId + "_")) {
                cleanupTempUpload(key);
            }
        }
        downloadCancelFlags.remove(sessionId);
        
        disconnectSSH(sessionId); // 确保SSH资源被正确释放
        System.out.println("WebSocket connection closed, sessionId: " + sessionId);
    }
    
    // 重写handleBinaryMessage方法，处理二进制消息
    @Override
    protected void handleBinaryMessage(WebSocketSession session, BinaryMessage message) {
        String sessionId = session.getId();
        
        try {
            // 检查是否有待处理的二进制上传
            Map<String, Object> uploadInfo = pendingBinaryUploads.get(sessionId);
            if (uploadInfo != null) {
                handleBinaryUpload(session, message, uploadInfo);
                return;
            }
            
            // 如果不是上传，则作为终端输出处理
            byte[] data = message.getPayload().array();
            String output = new String(data, "UTF-8");
            
            if (output != null && !output.isEmpty()) {
                try {
                    // 发送到终端
                    String textMessage = "{\"type\":\"output\",\"data\":" + escapeJson(output) + "}";
                    send(session, new TextMessage(textMessage));
                } catch (Exception e) {
                    System.err.println("Error handling binary message: " + e.getMessage());
                }
            }
        } catch (Exception e) {
            System.err.println("Error in handleBinaryMessage: " + e.getMessage());
        }
    }
    
    // 处理二进制上传数据（流式直写远程 + 增量 MD5，无需临时文件）
    private void handleBinaryUpload(WebSocketSession session, BinaryMessage message, Map<String, Object> uploadInfo) {
        String sessionId = session.getId();
        String fileName = (String) uploadInfo.get("fileName");
        String remotePath = (String) uploadInfo.get("remotePath");
        boolean isLastChunk = (boolean) uploadInfo.get("isLastChunk");
        Integer chunkIndex = (Integer) uploadInfo.get("chunkIndex");
        Integer totalChunks = (Integer) uploadInfo.get("totalChunks");
        boolean resumeUpload = uploadInfo.containsKey("resumeUpload") && (boolean) uploadInfo.get("resumeUpload");
        
        String uploadKey = sessionId + "_" + fileName;
        boolean success = false;
        
        try {
            byte[] fileData = message.getPayload().array();
            
            if (!remotePath.endsWith("/")) {
                remotePath += "/";
            }
            String remoteFilePath = remotePath + fileName;
            
            // 获取或创建 SFTP 输出流（第一个分片时创建）
            OutputStream sftpOut = sftpUploadStreams.get(uploadKey);
            java.security.MessageDigest md5Digest = uploadMd5Digests.get(uploadKey);
            
            if (sftpOut == null) {
                ChannelSftp channel = getSFTPChannel(sessionId);
                if (channel == null) {
                    pendingBinaryUploads.remove(sessionId);
                    sendErrorMessage(session, "SFTP通道创建失败");
                    return;
                }
                
                // 确保远程目录存在
                try {
                    channel.cd(remotePath);
                } catch (SftpException e) {
                    if (e.id == ChannelSftp.SSH_FX_NO_SUCH_FILE) {
                        createDirectoryRecursively(channel, remotePath);
                        channel.cd(remotePath);
                    } else {
                        throw e;
                    }
                }
                
                // 发送上传开始消息
                Map<String, Object> startResponse = new HashMap<>();
                startResponse.put("type", "sftp_upload_start");
                startResponse.put("fileName", fileName);
                send(session, new TextMessage(mapper.writeValueAsString(startResponse)));
                
                // 创建 SFTP 输出流：新上传 OVERWRITE，续传 APPEND
                int mode = resumeUpload ? ChannelSftp.APPEND : ChannelSftp.OVERWRITE;
                sftpOut = channel.put(fileName, mode);
                sftpUploadStreams.put(uploadKey, sftpOut);
                
                // 创建 MD5 增量摘要
                md5Digest = java.security.MessageDigest.getInstance("MD5");
                uploadMd5Digests.put(uploadKey, md5Digest);
                
                // 续传时：先读取远程已有部分更新 MD5 摘要，使本地 MD5 覆盖整个文件
                if (resumeUpload) {
                    long existingSize = 0;
                    try {
                        SftpATTRS attrs = channel.stat(remoteFilePath);
                        existingSize = attrs.getSize();
                    } catch (SftpException e) { }
                    if (existingSize > 0) {
                        System.out.println("续传: 读取远程已有部分 " + existingSize + " 字节用于 MD5 计算");
                        try (InputStream remoteIn = channel.get(remoteFilePath)) {
                            byte[] buffer = new byte[256 * 1024];
                            int len;
                            while ((len = remoteIn.read(buffer)) != -1) {
                                md5Digest.update(buffer, 0, len);
                            }
                        }
                    }
                }
                
                System.out.println("开始流式上传到远程: " + remoteFilePath + " (模式: " + (resumeUpload ? "APPEND" : "OVERWRITE") + ")");
            }
            
            // 直接写入远程文件 + 更新 MD5 摘要
            sftpOut.write(fileData);
            md5Digest.update(fileData);
            
            // 发送分片接收确认
            Map<String, Object> chunkResponse = new HashMap<>();
            chunkResponse.put("type", "sftp_chunk_received");
            chunkResponse.put("fileName", fileName);
            chunkResponse.put("chunkIndex", chunkIndex);
            chunkResponse.put("totalChunks", totalChunks);
            send(session, new TextMessage(mapper.writeValueAsString(chunkResponse)));
            
            // 最后一个分片：关闭流，计算 MD5 校验
            if (isLastChunk) {
                sftpOut.close();
                sftpUploadStreams.remove(uploadKey);
                uploadMd5Digests.remove(uploadKey);
                
                // 本地 MD5（从增量摘要）
                byte[] digest = md5Digest.digest();
                StringBuilder sb = new StringBuilder();
                for (byte b : digest) {
                    sb.append(String.format("%02x", b & 0xff));
                }
                String localMd5 = sb.toString();
                
                // 远程 MD5
                ChannelSftp channel = getSFTPChannel(sessionId);
                String remoteMd5 = calculateRemoteMD5(channel, remoteFilePath);
                
                Map<String, Object> resultResponse = new HashMap<>();
                resultResponse.put("type", "sftp_upload_result");
                resultResponse.put("success", true);
                resultResponse.put("fileName", fileName);
                resultResponse.put("path", remoteFilePath);
                resultResponse.put("localMd5", localMd5);
                resultResponse.put("remoteMd5", remoteMd5);
                resultResponse.put("md5Match", localMd5.equals(remoteMd5));
                resultResponse.put("resumed", resumeUpload);
                send(session, new TextMessage(mapper.writeValueAsString(resultResponse)));
                
                System.out.println("上传完成: " + remoteFilePath + " 本地MD5=" + localMd5 + " 远程MD5=" + remoteMd5);
            }
            
            success = true;
            
        } catch (Exception e) {
            e.printStackTrace();
            try {
                Map<String, Object> response = new HashMap<>();
                response.put("type", "sftp_upload_result");
                response.put("success", false);
                response.put("error", e.getMessage());
                send(session, new TextMessage(mapper.writeValueAsString(response)));
            } catch (IOException ex) {
                ex.printStackTrace();
            }
        } finally {
            // 非最后分片且成功：保持流开启，等待下一片
            // 最后分片或出错：清理资源
            if (isLastChunk || !success) {
                cleanupTempUpload(uploadKey);
                chunkProgress.remove(uploadKey);
            }
            pendingBinaryUploads.remove(sessionId);
        }
    }
    
    // 清理临时上传资源（SFTP 流 + MD5 摘要 + 临时文件）
    private void cleanupTempUpload(String uploadKey) {
        OutputStream sftpOut = sftpUploadStreams.remove(uploadKey);
        if (sftpOut != null) {
            try { sftpOut.close(); } catch (IOException e) {}
        }
        uploadMd5Digests.remove(uploadKey);
        java.io.FileOutputStream fos = tempUploadStreams.remove(uploadKey);
        if (fos != null) {
            try { fos.close(); } catch (IOException e) {}
        }
        java.io.File tempFile = tempUploadFiles.remove(uploadKey);
        if (tempFile != null && tempFile.exists()) {
            tempFile.delete();
        }
    }
    
    @Override
    protected void handleTextMessage(WebSocketSession session, TextMessage message) throws Exception {
        String payload = message.getPayload();
        String sessionId = session.getId();
        
        try {
            ObjectMapper mapper = new ObjectMapper();
            JsonNode rootNode = mapper.readTree(payload);
            String type = rootNode.get("type").asText();
            
            switch (type) {
                case "connect":
                    // 处理连接请求
                    connectSSH(session, payload);
                    break;
                case "data":
                    // 处理命令数据
                    sendCommand(sessionId, payload);
                    break;
                case "resize":
                    // 处理终端大小调整
                    resizeTerminal(sessionId, payload);
                    break;
                case "disconnect":
                    // 处理断开连接
                    disconnectSSH(sessionId);
                    break;
                case "sftp_list":
                    // 处理SFTP列出文件请求
                    handleSFTPList(session, rootNode);
                    break;
                case "sftp_upload":
                    // 处理SFTP上传请求
                    handleSFTPUploadRequest(session, rootNode);
                    break;
                case "sftp_data":
                    // 处理SFTP文件数据
                    handleSFTPData(session, rootNode);
                    break;
                case "sftp_download":
                    // 处理SFTP下载请求
                    handleSFTPDownload(session, rootNode);
                    break;
                case "sftp_upload_cancel":
                    handleSFTPUploadCancel(session, rootNode);
                    break;
                case "sftp_download_cancel":
                    downloadCancelFlags.put(sessionId, true);
                    System.out.println("下载取消请求: " + sessionId);
                    break;
                default:
                    send(session, new TextMessage("{\"type\":\"error\",\"message\":\"Unknown message type\"}"));
            }
        } catch (Exception e) {
            // 处理JSON解析错误
            e.printStackTrace();
            send(session, new TextMessage("{\"type\":\"error\",\"message\":\"Invalid JSON format\"}"));
        }
    }
    
    private void connectSSH(WebSocketSession session, String payload) throws IOException {
        String sessionId = session.getId();
        try {
            // 使用Jackson解析连接参数
            ObjectMapper mapper = new ObjectMapper();
            JsonNode rootNode = mapper.readTree(payload);
            
            String host = rootNode.get("host").asText();
            int port = rootNode.has("port") ? rootNode.get("port").asInt() : 22;
            String username = rootNode.get("username").asText();
            JsonNode authNode = rootNode.get("auth");
            String authType = authNode.get("type").asText();
            int cols = rootNode.has("cols") ? rootNode.get("cols").asInt() : 80;
            int rows = rootNode.has("rows") ? rootNode.get("rows").asInt() : 24;
            
            // 创建JSch对象
            JSch jsch = new JSch();
            
            // 记录实际使用的连接参数，避免因配置传递错误而误导排查
            System.out.println("[SSH] 尝试连接 host=" + host + ", port=" + port
                    + ", username=" + username + ", authType=" + authType);

            // 建立SSH会话
            Session sshSession = jsch.getSession(username, host, port);
            
            // 根据认证类型设置认证方式
            if (authType.equals("password")) {
                // 密码认证
                String password = authNode.get("password").asText();
                sshSession.setPassword(password);
            } else if (authType.equals("privatekey")) {
                // 私钥认证
                String privateKey = authNode.has("privateKey") ? authNode.get("privateKey").asText() : null;
                String passphrase = authNode.has("passphrase") ? authNode.get("passphrase").asText() : null;

                if (privateKey == null || privateKey.trim().isEmpty()) {
                    sendErrorMessage(session, "私钥内容为空");
                    return;
                }

                byte[] prvKey = privateKey.getBytes(java.nio.charset.StandardCharsets.UTF_8);
                byte[] pass = (passphrase != null && !passphrase.isEmpty())
                        ? passphrase.getBytes(java.nio.charset.StandardCharsets.UTF_8) : null;

                // 加载私钥：解析失败时 JSch 会跳过该 identity，必须先校验，避免最终只抛笼统的 Auth fail
                try {
                    jsch.addIdentity("privateKey", prvKey, null, pass);
                } catch (JSchException ex) {
                    System.err.println("[SSH] 私钥加载失败: " + ex.getMessage());
                    sendErrorMessage(session, "私钥加载失败，请确认内容完整且为受支持的格式（PEM / OpenSSH，含 ed25519）: " + ex.getMessage());
                    return;
                }

                int identityCount = jsch.getIdentityRepository().getIdentities().size();
                if (identityCount == 0) {
                    System.err.println("[SSH] 私钥解析后无任何可用 identity（格式不受支持或内容损坏）");
                    sendErrorMessage(session, "私钥解析失败：未识别到可用密钥，请检查格式与内容是否完整（支持 PEM、OpenSSH、ed25519）");
                    return;
                }
            }
            
            // 设置不检查主机密钥
            java.util.Properties config = new java.util.Properties();
            config.put("StrictHostKeyChecking", "no");
            sshSession.setConfig(config);
            
            // 连接SSH服务器（设置超时时间为10秒）
            sshSession.connect(10000);
            sshSessions.put(sessionId, sshSession);
            
            // 打开shell通道
            Channel channel = sshSession.openChannel("shell");
            ChannelShell shellChannel = (ChannelShell) channel;
            
            // 明确设置PTY为true（这是确保交互式shell正常工作的关键）
            shellChannel.setPty(true);
            
            // 设置终端类型和大小
            shellChannel.setPtyType("xterm");
            shellChannel.setPtySize(cols, rows, 0, 0);
            
            // 获取输入输出流
            InputStream in = shellChannel.getInputStream();
            OutputStream out = shellChannel.getOutputStream();
            sshOutputStreams.put(sessionId, out);
            
            // 启动通道
            shellChannel.connect();
            sshChannels.put(sessionId, shellChannel);
            
            // 发送连接成功消息
            send(session, new TextMessage("{\"type\":\"connect\",\"status\":\"success\"}"));
            
            // 启动线程读取SSH输出并发送到WebSocket
            startReadingThread(session, in);
            
        } catch (JSchException e) {
            // 打印根因(cause)，避免只看到笼统的 "Auth fail" 而无法定位
            System.err.println("[SSH] 连接失败: " + e.getMessage());
            Throwable cause = e.getCause();
            if (cause != null) {
                System.err.println("[SSH] 失败根因(cause): " + cause.getClass().getName() + ": " + cause.getMessage());
            }
            e.printStackTrace();

            String detail = e.getMessage();
            if (cause != null && cause.getMessage() != null) {
                detail += " (" + cause.getMessage() + ")";
            }
            sendErrorMessage(session, "SSH连接失败: " + detail);
        }
    }
    
    private void sendCommand(String sessionId, String payload) throws IOException {
        try {
            ObjectMapper mapper = new ObjectMapper();
            JsonNode rootNode = mapper.readTree(payload);
            String data = rootNode.get("data").asText();
            
            //System.out.println("Received command data: " + data);
            
            OutputStream out = sshOutputStreams.get(sessionId);
            if (out != null) {
                out.write(data.getBytes());
                out.flush();
                //System.out.println("Command data sent to SSH server");
            } else {
                System.out.println("No output stream found for session: " + sessionId);
            }
        } catch (Exception e) {
            e.printStackTrace();
            System.err.println("Error sending command: " + e.getMessage());
        }
    }
    
    private void resizeTerminal(String sessionId, String payload) {
        try {
            ObjectMapper mapper = new ObjectMapper();
            JsonNode rootNode = mapper.readTree(payload);
            int cols = rootNode.get("cols").asInt();
            int rows = rootNode.get("rows").asInt();
            
            ChannelShell channel = sshChannels.get(sessionId);
            if (channel != null && channel.isConnected()) {
                channel.setPtySize(cols, rows, 0, 0);
            }
        } catch (Exception e) {
            e.printStackTrace();
        }
    }
    
    private void disconnectSSH(String sessionId) {
        // 关闭SFTP通道
        ChannelSftp sftpChannel = sftpChannels.remove(sessionId);
        if (sftpChannel != null) {
            sftpChannel.disconnect();
        }
        
        // 关闭通道
        ChannelShell channel = sshChannels.remove(sessionId);
        if (channel != null) {
            channel.disconnect();
        }
        
        // 关闭会话
        Session session = sshSessions.remove(sessionId);
        if (session != null) {
            session.disconnect();
        }
        
        // 移除输出流
        sshOutputStreams.remove(sessionId);
        
        // 查找对应的WebSocket会话并发送断开连接消息
        for (WebSocketSession webSocketSession : webSocketSessions) {
            if (webSocketSession.getId().equals(sessionId)) {
                try {
                    // 先检查连接是否开放，再尝试发送消息
                    if (webSocketSession.isOpen()) {
                        // 使用同步块防止并发问题
                        synchronized (webSocketSession) {
                            send(webSocketSession, new TextMessage("{\"type\":\"disconnect\"}"));
                            System.out.println("Sent disconnect notification to client for session: " + sessionId);
                        }
                    }
                } catch (IOException e) {
                    System.err.println("Failed to send disconnect notification: " + e.getMessage());
                } catch (IllegalStateException e) {
                    // 专门捕获状态异常
                    System.err.println("WebSocket session state error: " + e.getMessage());
                }
                break;
            }
        }
    }
    
    /**
     * 线程安全地发送 WebSocket 消息。
     * 同一 session 被多个线程（终端输出读线程 + WebSocket 主线程）并发写时，
     * 底层容器会抛出 IllegalStateException(TEXT_PARTIAL_WRITING)；
     * 这里用会话级同步锁把发送串行化，并在发送前检查连接是否仍然打开。
     */
    private void send(WebSocketSession session, org.springframework.web.socket.WebSocketMessage<?> message) throws IOException {
        synchronized (session) {
            if (session.isOpen()) {
                session.sendMessage(message);
            }
        }
    }

    private void startReadingThread(final WebSocketSession session, final InputStream in) {
        new Thread(() -> {
            try {
                // 用 UTF-8 字符流读取：既固定编码，又由 Reader 处理跨读取块的多字节字符，避免中文被切断成乱码
                java.io.InputStreamReader reader = new java.io.InputStreamReader(in, java.nio.charset.StandardCharsets.UTF_8);
                char[] buffer = new char[2048];
                int len;
                while ((len = reader.read(buffer)) != -1 && session.isOpen()) {
                    String output = new String(buffer, 0, len);
                    //System.out.println("Sending output to client: 【" + output + "】");
                    
                    // 移除trim()调用，确保空格和控制字符不会被忽略
                    if (output != null && !output.isEmpty()) {
                        // 先尝试使用文本消息发送（更可靠的方式）
                        try {
                            // 直接发送文本消息，不进行复杂的转义
                            String message = "{\"type\":\"output\",\"data\":" + escapeJson(output) + "}";
                            send(session, new TextMessage(message));
                            //System.out.println("Sent as text message");
                        } catch (Exception e) {
                            System.err.println("Error sending text message: " + e.getMessage());
                            
                            // 文本发送失败通常表示连接已异常，不再降级为二进制，避免与文件下载共用二进制通道造成串扰
                            System.err.println("Terminal output send failed: " + e.getMessage());
                        }
                    }
                }
            } catch (IOException e) {
                e.printStackTrace();
                // 连接已关闭或出错
                try {
                    if (session.isOpen()) {
                        send(session, new TextMessage("{\"type\":\"disconnect\"}"));
                    }
                } catch (IOException ex) {
                    // 忽略
                }
            } finally {
                disconnectSSH(session.getId());
            }
        }).start();
    }
    
    // 辅助方法：JSON转义
    private String escapeJson(String input) {
        if (input == null) {
            return "null";
        }
        StringBuilder sb = new StringBuilder();
        sb.append('"');
        for (char c : input.toCharArray()) {
            switch (c) {
                case '"':
                    sb.append("\\\"");
                    break;
                case '\\':
                    sb.append("\\\\");
                    break;
                case '\b':
                    sb.append("\\b");
                    break;
                case '\f':
                    sb.append("\\f");
                    break;
                case '\n':
                    sb.append("\\n");
                    break;
                case '\r':
                    sb.append("\\r");
                    break;
                case '\t':
                    sb.append("\\t");
                    break;
                default:
                    if (c < ' ') {
                        // 控制字符用Unicode转义
                        sb.append(String.format("\\u%04x", (int) c));
                    } else {
                        sb.append(c);
                    }
                    break;
            }
        }
        sb.append('"');
        return sb.toString();
    }
    
    // 处理SFTP列出文件请求
    private void handleSFTPList(WebSocketSession session, JsonNode rootNode) {
        String sessionId = session.getId();
        String path = rootNode.get("path").asText();
        
        try {
            // 获取或创建SFTP通道
            ChannelSftp channel = getSFTPChannel(sessionId);
            if (channel == null) {
                sendErrorMessage(session, "SFTP通道创建失败");
                return;
            }
            
            // 列出文件
            List<Map<String, Object>> fileList = new ArrayList<>();
            @SuppressWarnings("unchecked")
            java.util.Vector<ChannelSftp.LsEntry> entries = channel.ls(path);
            
            for (ChannelSftp.LsEntry entry : entries) {
                // 跳过.和..
                if (".".equals(entry.getFilename()) || "..".equals(entry.getFilename())) {
                    continue;
                }
                
                SftpATTRS attrs = entry.getAttrs();
                Map<String, Object> fileInfo = new HashMap<>();
                fileInfo.put("name", entry.getFilename());
                fileInfo.put("isDirectory", attrs.isDir());
                fileInfo.put("size", attrs.getSize());
                fileInfo.put("permissions", entry.getLongname().substring(0, 10));
                fileInfo.put("modifiedTime", attrs.getMTime() * 1000L); // 转换为毫秒
                fileInfo.put("path", path + "/" + entry.getFilename());
                
                fileList.add(fileInfo);
            }
            
            // 发送文件列表到前端
            Map<String, Object> response = new HashMap<>();
            response.put("type", "sftp_list_result");
            response.put("files", fileList);
            send(session, new TextMessage(mapper.writeValueAsString(response)));
            
        } catch (Exception e) {
            e.printStackTrace();
            sendErrorMessage(session, "列出文件失败: " + e.getMessage());
        }
    }
    
    // 处理SFTP上传请求
    private void handleSFTPUploadRequest(WebSocketSession session, JsonNode rootNode) {
        try {
            String fileName = rootNode.get("fileName").asText();
            String remotePath = rootNode.get("remotePath").asText();
            long fileSize = rootNode.has("fileSize") ? rootNode.get("fileSize").asLong() : 0;
            
            String sessionId = session.getId();
            ChannelSftp channel = getSFTPChannel(sessionId);
            
            if (channel == null) {
                sendErrorMessage(session, "SFTP通道创建失败");
                return;
            }
            
            // 检查远程路径是否存在
            boolean pathExists = true;
            try {
                channel.stat(remotePath);
            } catch (SftpException e) {
                if (e.id == ChannelSftp.SSH_FX_NO_SUCH_FILE) {
                    pathExists = false;
                }
            }
            
            // 检查远程文件是否已存在（用于断点续传）
            long remoteExistingSize = 0;
            String remoteFilePath;
            if (remotePath.endsWith("/")) {
                remoteFilePath = remotePath + fileName;
            } else {
                remoteFilePath = remotePath + "/" + fileName;
            }
            try {
                SftpATTRS attrs = channel.stat(remoteFilePath);
                if (!attrs.isDir()) {
                    remoteExistingSize = attrs.getSize();
                }
            } catch (SftpException e) {
                // 文件不存在，remoteExistingSize 保持 0
            }
            
            Map<String, Object> response = new HashMap<>();
            response.put("type", "sftp_upload_ready");
            response.put("fileName", fileName);
            response.put("remotePath", remotePath);
            response.put("pathExists", pathExists);
            response.put("remoteExistingSize", remoteExistingSize);
            response.put("fileSize", fileSize);
            send(session, new TextMessage(mapper.writeValueAsString(response)));
        } catch (Exception e) {
            e.printStackTrace();
            sendErrorMessage(session, "准备上传文件失败: " + e.getMessage());
        }
    }
    
    // 处理上传取消请求
    private void handleSFTPUploadCancel(WebSocketSession session, JsonNode rootNode) {
        String sessionId = session.getId();
        String fileName = rootNode.get("fileName").asText();
        String uploadKey = sessionId + "_" + fileName;
        cleanupTempUpload(uploadKey);
        chunkProgress.remove(uploadKey);
        pendingBinaryUploads.remove(sessionId);
        System.out.println("上传已取消: " + fileName);
        try {
            Map<String, Object> response = new HashMap<>();
            response.put("type", "sftp_upload_result");
            response.put("success", false);
            response.put("fileName", fileName);
            response.put("error", "用户取消上传");
            response.put("cancelled", true);
            send(session, new TextMessage(mapper.writeValueAsString(response)));
        } catch (IOException e) {
            e.printStackTrace();
        }
    }
    
    // 存储分片上传的临时文件
    private ConcurrentHashMap<String, java.io.File> tempUploadFiles = new ConcurrentHashMap<>();
    
    // 存储分片上传的临时文件输出流
    private ConcurrentHashMap<String, java.io.FileOutputStream> tempUploadStreams = new ConcurrentHashMap<>();
    
    // 旧版 base64 上传的内存缓冲（向后兼容）
    private ConcurrentHashMap<String, ByteArrayOutputStream> chunkUploads = new ConcurrentHashMap<>();
    
    // 存储分片上传的进度信息
    private ConcurrentHashMap<String, Integer> chunkProgress = new ConcurrentHashMap<>();
    
    // 存储SFTP直接写入流（新上传时直接写远程文件，不经过临时文件）
    private ConcurrentHashMap<String, OutputStream> sftpUploadStreams = new ConcurrentHashMap<>();
    
    // 存储上传过程中的 MD5 增量摘要（无需临时文件即可计算本地 MD5）
    private ConcurrentHashMap<String, java.security.MessageDigest> uploadMd5Digests = new ConcurrentHashMap<>();
    
    // 下载取消标志
    private ConcurrentHashMap<String, Boolean> downloadCancelFlags = new ConcurrentHashMap<>();
    
    // 处理SFTP文件数据
    private void handleSFTPData(WebSocketSession session, JsonNode rootNode) {
        String sessionId = session.getId();
        String fileName = rootNode.get("fileName").asText();
        
        // 检查是否使用二进制传输
        boolean binaryTransfer = rootNode.has("binaryTransfer") && rootNode.get("binaryTransfer").asBoolean();
        
        // 如果是二进制传输，设置待处理标记并返回，等待二进制数据
        if (binaryTransfer) {
            // 获取远程路径，如果没有提供则使用根目录
            String remotePath = rootNode.has("remotePath") ? rootNode.get("remotePath").asText() : "/";
            
            // 检查是否是分片上传
            boolean isChunkedUpload = rootNode.has("totalChunks");
            boolean isLastChunk = rootNode.has("isLastChunk") ? rootNode.get("isLastChunk").asBoolean() : true;
            int chunkIndex = rootNode.has("chunkIndex") ? rootNode.get("chunkIndex").asInt() : 0;
            int totalChunks = rootNode.has("totalChunks") ? rootNode.get("totalChunks").asInt() : 1;
            
            // 存储上传信息，等待二进制数据
            Map<String, Object> uploadInfo = new HashMap<>();
            uploadInfo.put("fileName", fileName);
            uploadInfo.put("remotePath", remotePath);
            uploadInfo.put("isLastChunk", isLastChunk);
            uploadInfo.put("chunkIndex", chunkIndex);
            uploadInfo.put("totalChunks", totalChunks);
            uploadInfo.put("resumeUpload", rootNode.has("resumeUpload") && rootNode.get("resumeUpload").asBoolean());
            
            // 设置待处理标记
            pendingBinaryUploads.put(sessionId, uploadInfo);
            
            System.out.println("等待二进制数据上传: " + fileName + ", 分片: " + chunkIndex + "/" + totalChunks);
            return;
        }
        
        // 如果不是二进制传输，继续使用base64处理
        String fileDataBase64 = rootNode.get("fileData").asText();
        // 获取远程路径，如果没有提供则使用根目录
        String remotePath = rootNode.has("remotePath") ? rootNode.get("remotePath").asText() : "/";
        
        // 检查是否是分片上传
        boolean isChunkedUpload = rootNode.has("totalChunks");
        boolean isLastChunk = rootNode.has("isLastChunk") ? rootNode.get("isLastChunk").asBoolean() : true;
        int chunkIndex = rootNode.has("chunkIndex") ? rootNode.get("chunkIndex").asInt() : 0;
        int totalChunks = rootNode.has("totalChunks") ? rootNode.get("totalChunks").asInt() : 1;
        
        // 创建唯一的上传标识符
        String uploadKey = sessionId + "_" + fileName;
        
        try {
            // 增强型Base64解码与数据恢复机制
            byte[] fileData;
            try {
                // 基础验证
                if (fileDataBase64 == null || fileDataBase64.isEmpty()) {
                    sendErrorMessage(session, "Base64数据为空");
                    return;
                }
                
                String base64Data = fileDataBase64.trim();
                int originalLength = base64Data.length();
                
                // 记录调试信息
                System.out.println("开始解码Base64数据，长度: " + originalLength);
                if (originalLength > 100) {
                    System.out.println("数据样本(前100字符): " + base64Data.substring(0, 100));
                }
                
                // 验证并修复Base64格式
                base64Data = base64Data.replaceAll("[^A-Za-z0-9+/=]", "");
                if (base64Data.length() != originalLength) {
                    System.out.println("已过滤非法字符，新长度: " + base64Data.length());
                }
                
                // 确保长度是4的倍数
                int paddingNeeded = (4 - base64Data.length() % 4) % 4;
                if (paddingNeeded > 0) {
                    base64Data += "====".substring(0, paddingNeeded);
                    System.out.println("已添加填充字符，新长度: " + base64Data.length());
                }
                
                // 分块解码策略
                ByteArrayOutputStream outputStream = new ByteArrayOutputStream();
                Base64.Decoder decoder = Base64.getMimeDecoder(); // 使用MIME解码器更宽松
                int chunkSize = 4096; // 更小的分块(4KB)
                int successCount = 0;
                
                for (int i = 0; i < base64Data.length(); i += chunkSize) {
                    int end = Math.min(i + chunkSize, base64Data.length());
                    
                    // 确保分块在Base64字符边界上
                    while (end < base64Data.length() && 
                           end % 4 != 0 && 
                           base64Data.charAt(end) != '=') {
                        end++;
                    }
                    
                    String chunk = base64Data.substring(i, end);
                    
                    try {
                        byte[] decodedChunk = decoder.decode(chunk);
                        outputStream.write(decodedChunk);
                        successCount++;
                    } catch (IllegalArgumentException e) {
                        // 尝试修复损坏的分块
                        System.err.println("解码失败在位置: " + i + "-" + end + ", 尝试修复...");
                        
                        // 尝试调整分块边界
                        for (int adjust = 1; adjust <= 3 && end > i + adjust; adjust++) {
                            try {
                                String adjustedChunk = base64Data.substring(i, end - adjust);
                                byte[] decodedChunk = decoder.decode(adjustedChunk);
                                outputStream.write(decodedChunk);
                                System.err.println("通过调整边界(" + adjust + ")成功解码分块");
                                successCount++;
                                i -= adjust; // 调整指针位置
                                break;
                            } catch (IllegalArgumentException ex) {
                                continue;
                            }
                        }
                    }
                }
                
                System.out.println("成功解码分块数: " + successCount);
                
                fileData = outputStream.toByteArray();
                
                // 数据完整性验证
                if (rootNode.has("fileSize")) {
                    int expectedSize = rootNode.get("fileSize").asInt();
                    if (fileData.length != expectedSize) {
                        System.err.println("警告: 解码数据大小(" + fileData.length + 
                                        ")与预期(" + expectedSize + ")不符");
                    }
                }
                
            } catch (Exception e) {
                System.err.println("Base64解码严重错误: " + e.getMessage());
                sendErrorMessage(session, "处理文件数据时发生严重错误，请检查文件完整性");
                return;
            }
            
            // 如果是分片上传且不是最后一个分片，则存储分片数据
            if (isChunkedUpload && !isLastChunk) {
                try {
                    ByteArrayOutputStream outputStream = chunkUploads.computeIfAbsent(uploadKey, k -> new ByteArrayOutputStream(1024 * 1024)); // 预分配1MB缓冲区
                    outputStream.write(fileData);
                    
                    // 更新进度信息
                    chunkProgress.put(uploadKey, chunkIndex + 1);
                    
                    // 发送分片接收确认
                    Map<String, Object> response = new HashMap<>();
                    response.put("type", "sftp_chunk_received");
                    response.put("fileName", fileName);
                    response.put("chunkIndex", chunkIndex);
                    response.put("totalChunks", totalChunks);
                    response.put("progress", String.format("%.1f%%", (chunkIndex + 1) * 100.0 / totalChunks));
                    
                    try {
                        send(session, new TextMessage(mapper.writeValueAsString(response)));
                    } catch (IOException e) {
                        System.err.println("发送分片确认失败: " + e.getMessage());
                    }
                    
                    return; // 等待接收所有分片
                } catch (OutOfMemoryError e) {
                    // 内存不足，清理临时数据
                    chunkUploads.remove(uploadKey);
                    chunkProgress.remove(uploadKey);
                    sendErrorMessage(session, "服务器内存不足，无法处理此文件: " + e.getMessage());
                    return;
                }
            }
            
            // 如果是分片上传的最后一个分片，合并所有分片
            if (isChunkedUpload && isLastChunk) {
                ByteArrayOutputStream outputStream = chunkUploads.get(uploadKey);
                if (outputStream != null) {
                    try {
                        outputStream.write(fileData);
                        fileData = outputStream.toByteArray();
                    } catch (OutOfMemoryError e) {
                        // 内存不足，清理临时数据
                        chunkUploads.remove(uploadKey);
                        chunkProgress.remove(uploadKey);
                        sendErrorMessage(session, "合并分片时内存不足: " + e.getMessage());
                        return;
                    } finally {
                        // 清理临时数据
                        chunkUploads.remove(uploadKey);
                        chunkProgress.remove(uploadKey);
                    }
                }
            }
            
            // 获取或创建SFTP通道
            ChannelSftp channel = getSFTPChannel(sessionId);
            if (channel == null) {
                sendErrorMessage(session, "SFTP通道创建失败");
                return;
            }
            
            // 确保路径以/结尾
            if (!remotePath.endsWith("/")) {
                remotePath += "/";
            }
            
            // 上传文件
            ByteArrayInputStream inputStream = new ByteArrayInputStream(fileData);
            String remoteFilePath = remotePath + fileName;
            
            try {
                // 发送上传开始消息
                Map<String, Object> startResponse = new HashMap<>();
                startResponse.put("type", "sftp_upload_start");
                startResponse.put("fileName", fileName);
                send(session, new TextMessage(mapper.writeValueAsString(startResponse)));
                
                // 尝试切换到目标目录，如果不存在则创建
                try {
                    channel.cd(remotePath);
                } catch (SftpException e) {
                    if (e.id == ChannelSftp.SSH_FX_NO_SUCH_FILE) {
                        // 目录不存在，尝试创建
                        createDirectoryRecursively(channel, remotePath);
                        channel.cd(remotePath);
                    } else {
                        throw e;
                    }
                }
                
                // 上传文件到当前目录
                channel.put(inputStream, fileName);
                
                // 计算 MD5 校验
                String localMd5 = calculateMD5(fileData);
                String remoteMd5 = calculateRemoteMD5(channel, remoteFilePath);
                
                // 发送上传成功消息
                Map<String, Object> response = new HashMap<>();
                response.put("type", "sftp_upload_result");
                response.put("success", true);
                response.put("fileName", fileName);
                response.put("path", remoteFilePath);
                response.put("localMd5", localMd5);
                response.put("remoteMd5", remoteMd5);
                response.put("md5Match", localMd5.equals(remoteMd5));
                send(session, new TextMessage(mapper.writeValueAsString(response)));
                
            } catch (SftpException e) {
                try {
                    // 如果切换目录失败，尝试直接使用完整路径上传
                    channel.put(inputStream, remoteFilePath);
                    
                    // 计算 MD5 校验
                    String localMd5 = calculateMD5(fileData);
                    String remoteMd5 = calculateRemoteMD5(channel, remoteFilePath);
                    
                    // 发送上传成功消息
                    Map<String, Object> response = new HashMap<>();
                    response.put("type", "sftp_upload_result");
                    response.put("success", true);
                    response.put("fileName", fileName);
                    response.put("path", remoteFilePath);
                    response.put("localMd5", localMd5);
                    response.put("remoteMd5", remoteMd5);
                    response.put("md5Match", localMd5.equals(remoteMd5));
                    send(session, new TextMessage(mapper.writeValueAsString(response)));
                } catch (Exception ex) {
                    throw ex; // 重新抛出异常，让外层catch处理
                }
            }
            
        } catch (Exception e) {
            e.printStackTrace();
            try {
                // 清理可能存在的临时数据
                chunkUploads.remove(uploadKey);
                chunkProgress.remove(uploadKey);
                
                Map<String, Object> response = new HashMap<>();
                response.put("type", "sftp_upload_result");
                response.put("success", false);
                response.put("error", e.getMessage());
                send(session, new TextMessage(mapper.writeValueAsString(response)));
            } catch (IOException ex) {
                ex.printStackTrace();
            }
        }
    }
    
    // 递归创建目录
    private void createDirectoryRecursively(ChannelSftp channel, String path) throws SftpException {
        if (path.equals("/")) {
            return; // 根目录已存在
        }
        
        // 规范化路径
        String normalizedPath = path;
        if (normalizedPath.endsWith("/")) {
            normalizedPath = normalizedPath.substring(0, normalizedPath.length() - 1);
        }
        
        // 尝试切换到该目录
        try {
            channel.cd(normalizedPath);
            return; // 目录已存在
        } catch (SftpException e) {
            // 目录不存在，继续处理
        }
        
        // 获取父目录
        int lastSlashIndex = normalizedPath.lastIndexOf('/');
        if (lastSlashIndex <= 0) {
            // 直接在根目录下创建
            channel.cd("/");
            channel.mkdir(normalizedPath.substring(1));
            return;
        }
        
        // 递归创建父目录
        String parentPath = normalizedPath.substring(0, lastSlashIndex);
        createDirectoryRecursively(channel, parentPath);
        
        // 创建当前目录
        channel.cd(parentPath);
        String dirName = normalizedPath.substring(lastSlashIndex + 1);
        channel.mkdir(dirName);
    }
    
    // 处理SFTP下载请求
    private void handleSFTPDownload(WebSocketSession session, JsonNode rootNode) {
        String sessionId = session.getId();
        String path = rootNode.get("path").asText();
        String fileName = rootNode.get("fileName").asText();
        
        // 检查是否使用二进制传输
        boolean binaryTransfer = rootNode.has("binaryTransfer") && rootNode.get("binaryTransfer").asBoolean();
        
        try {
            // 获取或创建SFTP通道
            ChannelSftp channel = getSFTPChannel(sessionId);
            if (channel == null) {
                sendErrorMessage(session, "SFTP通道创建失败");
                return;
            }
            
            // 确保路径正确
            String fullPath;
            if (path.endsWith("/" + fileName)) {
                // 路径已经包含文件名
                fullPath = path;
            } else {
                // 路径不包含文件名，需要拼接
                if (!path.endsWith("/")) {
                    path += "/";
                }
                fullPath = path + fileName;
            }
            
            // 检查文件是否存在并获取文件大小
            long fileSize;
            try {
                SftpATTRS attrs = channel.stat(fullPath);
                if (attrs.isDir()) {
                    sendErrorMessage(session, "指定的路径是一个目录，不是文件");
                    return;
                }
                fileSize = attrs.getSize();
            } catch (SftpException e) {
                if (e.id == ChannelSftp.SSH_FX_NO_SUCH_FILE) {
                    sendErrorMessage(session, "文件不存在: " + fullPath);
                } else {
                    sendErrorMessage(session, "检查文件状态失败: " + e.getMessage());
                }
                return;
            }
            
            int chunkSize = 256 * 1024; // 256KB per chunk
            
            // 发送下载开始消息（元数据）
            Map<String, Object> startResponse = new HashMap<>();
            startResponse.put("type", "sftp_download_start");
            startResponse.put("fileName", fileName);
            startResponse.put("fileSize", fileSize);
            startResponse.put("chunkSize", chunkSize);
            send(session, new TextMessage(mapper.writeValueAsString(startResponse)));
            
            // 用自定义 OutputStream 流式分块发送：channel.get(remotePath, outputStream) 是验证过的可靠路径
            final WebSocketSession sess = session;
            final int cs = chunkSize;
            java.io.OutputStream chunkedOutputStream = new java.io.OutputStream() {
                private byte[] buffer = new byte[cs];
                private int pos = 0;
                private long totalSent = 0;
                
                @Override
                public void write(int b) throws IOException {
                    buffer[pos++] = (byte) b;
                    if (pos == cs) flushChunk();
                }
                
                @Override
                public void write(byte[] b, int off, int len) throws IOException {
                    while (len > 0) {
                        int space = cs - pos;
                        int copy = Math.min(len, space);
                        System.arraycopy(b, off, buffer, pos, copy);
                        pos += copy;
                        off += copy;
                        len -= copy;
                        if (pos == cs) flushChunk();
                    }
                }
                
                private void flushChunk() throws IOException {
                    if (downloadCancelFlags.containsKey(sessionId)) {
                        throw new IOException("下载已取消");
                    }
                    if (pos > 0) {
                        byte[] chunk = pos == cs ? buffer : java.util.Arrays.copyOf(buffer, pos);
                        send(sess, new BinaryMessage(chunk));
                        totalSent += pos;
                        pos = 0;
                    }
                }
                
                @Override
                public void close() throws IOException {
                    flushChunk();
                }
                
                public long getTotalSent() { return totalSent; }
            };
            
            // 在独立线程中执行下载，使取消消息能被处理
            final ChannelSftp dlChannel = channel;
            final String dlFullPath = fullPath;
            final long dlFileSize = fileSize;
            final String dlFileName = fileName;
            new Thread(() -> {
                try {
                    dlChannel.get(dlFullPath, chunkedOutputStream);
                    downloadCancelFlags.remove(sessionId);
                    Map<String, Object> completeResponse = new HashMap<>();
                    completeResponse.put("type", "sftp_download_complete");
                    completeResponse.put("fileName", dlFileName);
                    completeResponse.put("fileSize", dlFileSize);
                    send(session, new TextMessage(mapper.writeValueAsString(completeResponse)));
                    System.out.println("流式下载完成: " + dlFileName + ", 大小: " + dlFileSize + " 字节");
                } catch (Exception e) {
                    downloadCancelFlags.remove(sessionId);
                    boolean cancelled = (e.getMessage() != null && e.getMessage().contains("取消"));
                    try {
                        Map<String, Object> response = new HashMap<>();
                        response.put("type", "sftp_download_error");
                        response.put("fileName", dlFileName);
                        response.put("error", cancelled ? "用户取消下载" : e.getMessage());
                        response.put("cancelled", cancelled);
                        send(session, new TextMessage(mapper.writeValueAsString(response)));
                    } catch (IOException ex) {
                        ex.printStackTrace();
                    }
                }
            }, "sftp-download-" + sessionId).start();
            
        } catch (Exception e) {
            e.printStackTrace();
            try {
                Map<String, Object> response = new HashMap<>();
                response.put("type", "sftp_download_error");
                response.put("fileName", fileName);
                response.put("error", e.getMessage());
                send(session, new TextMessage(mapper.writeValueAsString(response)));
            } catch (IOException ex) {
                ex.printStackTrace();
            }
        }
    }
    
    // 计算字节数组的 MD5
    private String calculateMD5(byte[] data) {
        try {
            java.security.MessageDigest md = java.security.MessageDigest.getInstance("MD5");
            byte[] digest = md.digest(data);
            StringBuilder sb = new StringBuilder();
            for (byte b : digest) {
                sb.append(String.format("%02x", b & 0xff));
            }
            return sb.toString();
        } catch (Exception e) {
            return "计算失败: " + e.getMessage();
        }
    }
    
    // 计算本地临时文件的 MD5
    private String calculateFileMD5(java.io.File file) {
        try {
            java.security.MessageDigest md = java.security.MessageDigest.getInstance("MD5");
            try (java.io.FileInputStream fis = new java.io.FileInputStream(file)) {
                byte[] buffer = new byte[256 * 1024];
                int len;
                while ((len = fis.read(buffer)) != -1) {
                    md.update(buffer, 0, len);
                }
            }
            byte[] digest = md.digest();
            StringBuilder sb = new StringBuilder();
            for (byte b : digest) {
                sb.append(String.format("%02x", b & 0xff));
            }
            return sb.toString();
        } catch (Exception e) {
            return "计算失败: " + e.getMessage();
        }
    }
    
    // 通过 SFTP 读取远程文件并计算 MD5
    private String calculateRemoteMD5(ChannelSftp channel, String remoteFilePath) {
        try {
            java.security.MessageDigest md = java.security.MessageDigest.getInstance("MD5");
            java.io.OutputStream digestStream = new java.io.OutputStream() {
                @Override
                public void write(int b) {
                    md.update((byte) b);
                }
                @Override
                public void write(byte[] b, int off, int len) {
                    md.update(b, off, len);
                }
            };
            channel.get(remoteFilePath, digestStream);
            byte[] digest = md.digest();
            StringBuilder sb = new StringBuilder();
            for (byte b : digest) {
                sb.append(String.format("%02x", b & 0xff));
            }
            return sb.toString();
        } catch (Exception e) {
            return "计算失败: " + e.getMessage();
        }
    }
    
    // 获取或创建SFTP通道
    private ChannelSftp getSFTPChannel(String sessionId) throws JSchException {
        // 检查是否已经有可用的SFTP通道
        ChannelSftp channel = sftpChannels.get(sessionId);
        if (channel != null && channel.isConnected()) {
            return channel;
        }
        
        // 检查是否有可用的SSH会话
        Session sshSession = sshSessions.get(sessionId);
        if (sshSession == null || !sshSession.isConnected()) {
            return null;
        }
        
        // 创建新的SFTP通道
        channel = (ChannelSftp) sshSession.openChannel("sftp");
        channel.connect();
        sftpChannels.put(sessionId, channel);
        
        return channel;
    }
    
    // 发送错误消息
    private void sendErrorMessage(WebSocketSession session, String message) {
        try {
            send(session, new TextMessage("{\"type\":\"error\",\"message\":\"" + message.replaceAll("\\\"", "\\\\\"") + "\"}"));
        } catch (IOException e) {
            e.printStackTrace();
        }
    }
    

    
    // 添加ObjectMapper实例
    private ObjectMapper mapper = new ObjectMapper();
}

