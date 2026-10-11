package com.web_ssh.controller;

import com.web_ssh.model.SSHServerConfig;
import com.web_ssh.service.SSHServerConfigService;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

import java.util.List;
import java.util.Map;
import java.util.HashMap;

/**
 * SSH服务器配置控制器
 * 提供REST API接口，用于管理SSH服务器配置
 */
@RestController
@RequestMapping("/api/ssh-servers")
public class SSHServerConfigController {

    @Autowired
    private SSHServerConfigService sshServerConfigService;
    
    /**
     * 获取所有服务器配置
     * @return 服务器配置列表
     */
    @GetMapping
    public ResponseEntity<List<SSHServerConfig>> getAllConfigs() {
        return ResponseEntity.ok(sshServerConfigService.getAllConfigs());
    }
    
    /**
     * 根据ID获取服务器配置
     * @param id 配置ID
     * @return 服务器配置
     */
    @GetMapping("/{id}")
    public ResponseEntity<SSHServerConfig> getConfigById(@PathVariable String id) {
        SSHServerConfig config = sshServerConfigService.getConfigById(id);
        if (config != null) {
            return ResponseEntity.ok(config);
        } else {
            return ResponseEntity.notFound().build();
        }
    }
    
    /**
     * 添加新的服务器配置
     * @param config 服务器配置
     * @return 添加后的配置
     */
    @PostMapping
    public ResponseEntity<SSHServerConfig> addConfig(@RequestBody SSHServerConfig config) {
        SSHServerConfig savedConfig = sshServerConfigService.addConfig(config);
        return ResponseEntity.status(HttpStatus.CREATED).body(savedConfig);
    }
    
    /**
     * 更新服务器配置
     * @param id 配置ID
     * @param config 更新后的配置
     * @return 更新结果
     */
    @PutMapping("/{id}")
    public ResponseEntity<SSHServerConfig> updateConfig(@PathVariable String id, @RequestBody SSHServerConfig config) {
        config.setId(id); // 确保ID一致
        boolean updated = sshServerConfigService.updateConfig(config);
        if (updated) {
            return ResponseEntity.ok(config);
        } else {
            return ResponseEntity.notFound().build();
        }
    }
    
    /**
     * 删除服务器配置
     * @param id 配置ID
     * @return 删除结果
     */
    @DeleteMapping("/{id}")
    public ResponseEntity<Map<String, Boolean>> deleteConfig(@PathVariable String id) {
        boolean deleted = sshServerConfigService.deleteConfig(id);
        Map<String, Boolean> response = new HashMap<>();
        response.put("success", deleted);
        if (deleted) {
            return ResponseEntity.ok(response);
        } else {
            return ResponseEntity.notFound().build();
        }
    }
    
    /**
     * 搜索服务器配置
     * @param keyword 关键字
     * @return 匹配的服务器配置列表
     */
    @GetMapping("/search")
    public ResponseEntity<List<SSHServerConfig>> searchConfigs(@RequestParam(required = false) String keyword) {
        return ResponseEntity.ok(sshServerConfigService.searchConfigs(keyword));
    }
}
