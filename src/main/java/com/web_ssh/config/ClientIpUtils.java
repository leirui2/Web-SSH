package com.web_ssh.config;

import jakarta.servlet.http.HttpServletRequest;

/**
 * 客户端 IP 解析工具。
 *
 * 默认只信任 TCP 层真实来源（getRemoteAddr）；仅当前方存在可信反代且
 * webssh.auth.trust-proxy-headers=true 时，才采信代理头，避免被伪造绕过。
 */
public final class ClientIpUtils {

    private ClientIpUtils() {
    }

    public static String resolve(HttpServletRequest request, boolean trustProxyHeaders) {
        if (trustProxyHeaders) {
            String forwarded = request.getHeader("X-Forwarded-For");
            if (forwarded != null && !forwarded.isBlank() && !"unknown".equalsIgnoreCase(forwarded)) {
                int comma = forwarded.indexOf(',');
                return (comma > 0 ? forwarded.substring(0, comma) : forwarded).trim();
            }
            String realIp = request.getHeader("X-Real-IP");
            if (realIp != null && !realIp.isBlank()) {
                return realIp.trim();
            }
        }
        return request.getRemoteAddr();
    }
}
