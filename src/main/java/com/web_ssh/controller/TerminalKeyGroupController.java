package com.web_ssh.controller;

import com.web_ssh.model.TerminalKeyGroup;
import com.web_ssh.service.TerminalKeyGroupService;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;
import io.swagger.v3.oas.annotations.tags.Tag;

import java.util.List;

/**
 * 终端按键组配置控制器
 */
@RestController
@RequestMapping("/api/terminal-key-groups")
@Tag(name = "TerminalKeyGroupController", description = "终端按键组配置控制器")
public class TerminalKeyGroupController {

    @Autowired
    private TerminalKeyGroupService terminalKeyGroupService;
    
    /**
     * 获取所有按键组配置
     * @return 按键组配置列表
     */
    @GetMapping
    public ResponseEntity<List<TerminalKeyGroup>> getAllKeyGroups() {
        return ResponseEntity.ok(terminalKeyGroupService.getAllKeyGroups());
    }
    
    /**
     * 根据ID获取按键组配置
     * @param id 配置ID
     * @return 按键组配置
     */
    @GetMapping("/{id}")
    public ResponseEntity<TerminalKeyGroup> getKeyGroupById(@PathVariable String id) {
        TerminalKeyGroup keyGroup = terminalKeyGroupService.getKeyGroupById(id);
        if (keyGroup != null) {
            return ResponseEntity.ok(keyGroup);
        } else {
            return ResponseEntity.notFound().build();
        }
    }
    
    /**
     * 添加新的按键组配置
     * @param keyGroup 按键组配置
     * @return 添加后的配置
     */
    @PostMapping
    public ResponseEntity<TerminalKeyGroup> addKeyGroup(@RequestBody TerminalKeyGroup keyGroup) {
        return ResponseEntity.ok(terminalKeyGroupService.addKeyGroup(keyGroup));
    }
    
    /**
     * 更新按键组配置
     * @param id 配置ID
     * @param keyGroup 更新后的配置
     * @return 更新是否成功
     */
    @PutMapping("/{id}")
    public ResponseEntity<Void> updateKeyGroup(@PathVariable String id, @RequestBody TerminalKeyGroup keyGroup) {
        keyGroup.setId(id);
        boolean updated = terminalKeyGroupService.updateKeyGroup(keyGroup);
        if (updated) {
            return ResponseEntity.ok().build();
        } else {
            return ResponseEntity.notFound().build();
        }
    }
    
    /**
     * 删除按键组配置
     * @param id 配置ID
     * @return 删除是否成功
     */
    @DeleteMapping("/{id}")
    public ResponseEntity<Void> deleteKeyGroup(@PathVariable String id) {
        boolean deleted = terminalKeyGroupService.deleteKeyGroup(id);
        if (deleted) {
            return ResponseEntity.ok().build();
        } else {
            return ResponseEntity.notFound().build();
        }
    }
}