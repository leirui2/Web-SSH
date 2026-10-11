package com.web_ssh.controller;

import com.web_ssh.config.AuthProperties;
import org.springframework.stereotype.Controller;
import org.springframework.ui.Model;
import org.springframework.web.bind.annotation.GetMapping;

@Controller
public class SSHController {

    private final AuthProperties authProperties;

    public SSHController(AuthProperties authProperties) {
        this.authProperties = authProperties;
    }

    @GetMapping("/")
    public String index() {
        return "redirect:/ssh-client";
    }

    @GetMapping("/ssh-client")
    public String sshClient(Model model) {
        model.addAttribute("authEnabled", authProperties.isEnabled());
        return "ssh-client";
    }

    @GetMapping("/ssh-server-config")
    public String sshServerConfig(Model model) {
        model.addAttribute("authEnabled", authProperties.isEnabled());
        return "ssh-server-config";
    }
}
