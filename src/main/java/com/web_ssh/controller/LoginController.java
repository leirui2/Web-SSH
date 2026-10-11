package com.web_ssh.controller;

import com.web_ssh.config.AuthFilter;
import com.web_ssh.config.AuthProperties;
import com.web_ssh.config.ClientIpUtils;
import com.web_ssh.config.LoginAttemptService;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpSession;
import org.springframework.stereotype.Controller;
import org.springframework.ui.Model;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestParam;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;

/**
 * 登录/登出控制器。
 *
 * 仅在 webssh.auth.enabled=true 时生效；关闭时直接跳转客户端，不做任何校验。
 */
@Controller
public class LoginController {

    private final AuthProperties props;

    private final LoginAttemptService attemptService;

    public LoginController(AuthProperties props, LoginAttemptService attemptService) {
        this.props = props;
        this.attemptService = attemptService;
    }

    @GetMapping("/login")
    public String loginPage(HttpServletRequest request) {
        if (!props.isEnabled()) {
            return "redirect:/ssh-client";
        }
        HttpSession session = request.getSession(false);
        if (session != null && Boolean.TRUE.equals(session.getAttribute(AuthFilter.SESSION_KEY))) {
            return "redirect:/ssh-client";
        }
        return "login";
    }

    @PostMapping("/login")
    public String doLogin(@RequestParam(value = "username", required = false) String username,
                          @RequestParam(value = "password", required = false) String password,
                          HttpServletRequest request, Model model) {
        if (!props.isEnabled()) {
            return "redirect:/ssh-client";
        }

        String clientIp = ClientIpUtils.resolve(request, props.isTrustProxyHeaders());
        if (attemptService.isBlocked(clientIp)) {
            model.addAttribute("error", "您的 IP 已被封禁，如需解封请联系管理员");
            return "login";
        }

        if (matches(username, props.getUsername()) && matches(password, props.getPassword())) {
            attemptService.reset(clientIp);
            HttpSession session = request.getSession(true);
            session.setAttribute(AuthFilter.SESSION_KEY, true);
            return "redirect:/ssh-client";
        }

        attemptService.recordFailure(clientIp);
        if (attemptService.isBlocked(clientIp)) {
            model.addAttribute("error", "登录失败次数过多，您的 IP 已被永久封禁");
        } else {
            int remaining = Math.max(0, props.getMaxFailCount() - attemptService.getFailCount(clientIp));
            model.addAttribute("error", "用户名或密码错误，还可尝试 " + remaining + " 次");
        }
        return "login";
    }

    @GetMapping("/logout")
    public String logout(HttpServletRequest request) {
        if (!props.isEnabled()) {
            return "redirect:/ssh-client";
        }
        HttpSession session = request.getSession(false);
        if (session != null) {
            session.invalidate();
        }
        return "redirect:/login";
    }

    private boolean matches(String input, String expected) {
        if (input == null || expected == null) {
            return false;
        }
        return MessageDigest.isEqual(input.getBytes(StandardCharsets.UTF_8),
                expected.getBytes(StandardCharsets.UTF_8));
    }
}
