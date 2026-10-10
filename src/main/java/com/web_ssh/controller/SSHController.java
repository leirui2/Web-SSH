package com.web_ssh.controller;

import org.springframework.stereotype.Controller;
import org.springframework.web.bind.annotation.GetMapping;
import io.swagger.v3.oas.annotations.tags.Tag;

@Controller
@Tag(name = "SSHController", description = "SSH客户端控制器")
public class SSHController {
    
    @GetMapping("/ssh-client")
    public String sshClient() {
        return "ssh-client";
    }
    
    @GetMapping("/ssh-server-config")
    public String sshServerConfig() {
        return "ssh-server-config";
    }
}