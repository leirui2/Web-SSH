package com.web_ssh.config;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import com.fasterxml.jackson.databind.ObjectMapper;
import jakarta.annotation.PostConstruct;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;

import java.io.File;
import java.io.IOException;
import java.util.HashMap;
import java.util.Map;

/**
 * 登录失败计数与持久化封禁。
 *
 * 以客户端 IP 为维度统计失败次数，达到 webssh.auth.max-fail-count 后
 * 永久封禁并写入 webssh.auth.block-file，服务重启后仍生效。
 * 解封：编辑该文件删除对应 IP（或删除整个文件）后重启。
 */
@Component
public class LoginAttemptService {

    private static final Logger log = LoggerFactory.getLogger(LoginAttemptService.class);

    private final AuthProperties props;

    private final ObjectMapper mapper = new ObjectMapper();

    /** 永久封禁名单：IP -> 封禁时间戳 */
    private final Map<String, Long> blockedIps = new HashMap<>();

    /** 失败计数：IP -> 记录 */
    private final Map<String, Attempt> attempts = new HashMap<>();

    public LoginAttemptService(AuthProperties props) {
        this.props = props;
    }

    @PostConstruct
    public synchronized void load() {
        File file = blockFile();
        if (file == null) {
            log.info("[Auth] 未配置封禁文件路径(webssh.auth.block-file)，封禁名单仅存内存");
            return;
        }
        log.info("[Auth] 封禁文件路径: {}", file.getAbsolutePath());
        if (!file.exists()) {
            return;
        }
        try {
            StoreData data = mapper.readValue(file, StoreData.class);
            if (data != null) {
                if (data.blockedIps != null) {
                    blockedIps.putAll(data.blockedIps);
                }
                if (data.attempts != null) {
                    attempts.putAll(data.attempts);
                }
            }
            log.info("[Auth] 已加载封禁文件 {}：{} 个被封 IP，{} 个失败计数",
                    file.getAbsolutePath(), blockedIps.size(), attempts.size());
        } catch (IOException e) {
            log.error("[Auth] 加载封禁文件失败({}): {}", file.getAbsolutePath(), e.getMessage());
        }
    }

    public synchronized boolean isBlocked(String ip) {
        return ip != null && blockedIps.containsKey(ip);
    }

    public synchronized int getFailCount(String ip) {
        Attempt attempt = attempts.get(ip);
        return attempt == null ? 0 : attempt.failCount;
    }

    public synchronized void recordFailure(String ip) {
        if (ip == null) {
            return;
        }
        long now = System.currentTimeMillis();
        int maxFailCount = Math.max(1, props.getMaxFailCount());
        // lockSeconds <= 0：失败次数永久累计（推荐，防止慢速爆破绕过封禁）
        long windowMillis = props.getLockSeconds() > 0 ? props.getLockSeconds() * 1000L : 0L;

        Attempt attempt = attempts.get(ip);
        if (attempt == null || (windowMillis > 0 && attempt.lastFailTime < now - windowMillis)) {
            attempt = new Attempt();
        }
        attempt.failCount++;
        attempt.lastFailTime = now;

        if (attempt.failCount >= maxFailCount) {
            blockedIps.put(ip, now);
            attempts.remove(ip);
            log.warn("[Auth] IP {} 登录累计失败达 {} 次，已永久封禁", ip, maxFailCount);
        } else {
            attempts.put(ip, attempt);
        }
        save();
    }

    public synchronized void reset(String ip) {
        if (ip != null && attempts.remove(ip) != null) {
            save();
        }
    }

    private synchronized void save() {
        File file = blockFile();
        if (file == null) {
            return;
        }
        try {
            File parent = file.getParentFile();
            if (parent != null && !parent.exists()) {
                parent.mkdirs();
            }
            StoreData data = new StoreData();
            data.blockedIps = new HashMap<>(blockedIps);
            data.attempts = new HashMap<>(attempts);
            mapper.writerWithDefaultPrettyPrinter().writeValue(file, data);
        } catch (IOException e) {
            log.error("[Auth] 保存封禁文件失败({}): {}", file.getAbsolutePath(), e.getMessage());
        }
    }

    private File blockFile() {
        String path = props.getBlockFile();
        if (path == null || path.isBlank()) {
            return null;
        }
        return new File(path);
    }

    public static class StoreData {
        public Map<String, Long> blockedIps = new HashMap<>();
        public Map<String, Attempt> attempts = new HashMap<>();
    }

    @JsonIgnoreProperties(ignoreUnknown = true)
    public static class Attempt {
        public int failCount;
        public long lastFailTime;
    }
}
