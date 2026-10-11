package com.web_ssh.config;

import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import jakarta.servlet.http.HttpSession;
import org.springframework.web.filter.OncePerRequestFilter;

import java.io.IOException;

/**
 * 登录鉴权过滤器。
 *
 * enabled=false 时直接放行；enabled=true 时：
 * 1. 被封禁 IP 的所有请求一律拒绝（整站封禁，含 WebSocket）；
 * 2. 除登录页与静态资源外的请求（含 WebSocket 握手 /ssh-connect）必须携带已登录的 HttpSession。
 */
public class AuthFilter extends OncePerRequestFilter {

    public static final String SESSION_KEY = "WEBSSH_AUTHENTICATED";

    private final AuthProperties props;

    private final LoginAttemptService attemptService;

    public AuthFilter(AuthProperties props, LoginAttemptService attemptService) {
        this.props = props;
        this.attemptService = attemptService;
    }

    @Override
    protected void doFilterInternal(HttpServletRequest request, HttpServletResponse response, FilterChain filterChain)
            throws ServletException, IOException {

        if (!props.isEnabled()) {
            filterChain.doFilter(request, response);
            return;
        }

        String clientIp = ClientIpUtils.resolve(request, props.isTrustProxyHeaders());
        if (attemptService.isBlocked(clientIp)) {
            response.setStatus(HttpServletResponse.SC_FORBIDDEN);
            response.setContentType("text/plain;charset=UTF-8");
            response.getWriter().write("您的 IP(" + clientIp + ") 已被封禁，如需解封请联系管理员。");
            return;
        }

        String contextPath = request.getContextPath();
        String path = request.getRequestURI();
        String relative = (contextPath != null && !contextPath.isEmpty() && path.startsWith(contextPath))
                ? path.substring(contextPath.length()) : path;

        if (isWhitelisted(relative)) {
            filterChain.doFilter(request, response);
            return;
        }

        HttpSession session = request.getSession(false);
        boolean authenticated = session != null
                && Boolean.TRUE.equals(session.getAttribute(SESSION_KEY));
        if (authenticated) {
            filterChain.doFilter(request, response);
            return;
        }

        // 未登录：WebSocket 握手与 AJAX 返回 401，其余页面请求重定向到登录页
        if (isWebSocketRequest(request, relative) || isAjaxRequest(request)) {
            response.setStatus(HttpServletResponse.SC_UNAUTHORIZED);
            return;
        }
        response.sendRedirect(contextPath + "/login");
    }

    private boolean isWhitelisted(String relative) {
        return relative.equals("/login")
                || relative.equals("/logout")
                || relative.startsWith("/css/")
                || relative.startsWith("/js/")
                || relative.equals("/favicon.ico");
    }

    private boolean isWebSocketRequest(HttpServletRequest request, String relative) {
        String upgrade = request.getHeader("Upgrade");
        return relative.equals("/ssh-connect")
                || (upgrade != null && upgrade.equalsIgnoreCase("websocket"));
    }

    private boolean isAjaxRequest(HttpServletRequest request) {
        String requestedWith = request.getHeader("X-Requested-With");
        if ("XMLHttpRequest".equalsIgnoreCase(requestedWith)) {
            return true;
        }
        String accept = request.getHeader("Accept");
        return accept != null && accept.contains("application/json");
    }
}
