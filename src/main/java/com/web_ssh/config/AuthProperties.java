package com.web_ssh.config;

import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.stereotype.Component;

/**
 * 网页登录鉴权配置。
 */
@Component
@ConfigurationProperties(prefix = "webssh.auth")
public class AuthProperties {

    private boolean enabled = false;

    private String username = "admin";

    private String password = "";

    private int maxFailCount = 5;

    private int lockSeconds = 0;

    private boolean trustProxyHeaders = false;

    private String blockFile = "./data/webssh-blocked-ips.json";

    public boolean isEnabled() {
        return enabled;
    }

    public void setEnabled(boolean enabled) {
        this.enabled = enabled;
    }

    public String getUsername() {
        return username;
    }

    public void setUsername(String username) {
        this.username = username;
    }

    public String getPassword() {
        return password;
    }

    public void setPassword(String password) {
        this.password = password;
    }

    public int getMaxFailCount() {
        return maxFailCount;
    }

    public void setMaxFailCount(int maxFailCount) {
        this.maxFailCount = maxFailCount;
    }

    public int getLockSeconds() {
        return lockSeconds;
    }

    public void setLockSeconds(int lockSeconds) {
        this.lockSeconds = lockSeconds;
    }

    public boolean isTrustProxyHeaders() {
        return trustProxyHeaders;
    }

    public void setTrustProxyHeaders(boolean trustProxyHeaders) {
        this.trustProxyHeaders = trustProxyHeaders;
    }

    public String getBlockFile() {
        return blockFile;
    }

    public void setBlockFile(String blockFile) {
        this.blockFile = blockFile;
    }
}
