package com.web_ssh.service;

import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.web_ssh.model.TerminalKeyGroup;
import org.springframework.stereotype.Service;

import jakarta.annotation.PostConstruct;
import java.io.File;
import java.io.IOException;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;

/**
 * 终端按键组配置服务类
 * 负责管理终端按键组配置的保存和读取
 */
@Service
public class TerminalKeyGroupService {

    private static final String CONFIG_FILE_PATH = "terminal_key_groups.json";
    private final ObjectMapper objectMapper = new ObjectMapper();
    private List<TerminalKeyGroup> keyGroups = new ArrayList<>();
    
    /**
     * 初始化方法，在服务启动时加载配置
     */
    @PostConstruct
    public void init() {
        loadConfigs();
        
        // 如果没有配置，创建默认配置
        if (keyGroups.isEmpty()) {
            createDefaultKeyGroups();
        }
    }
    
    /**
     * 创建默认按键组配置
     */
    private void createDefaultKeyGroups() {
        // Linux常用命令组
        TerminalKeyGroup linuxGroup = new TerminalKeyGroup();
        linuxGroup.setId(UUID.randomUUID().toString());
        linuxGroup.setName("Linux常用命令");
        
        linuxGroup.addKey(new TerminalKeyGroup.TerminalKey("ls -la", "ls -la\n"));
        linuxGroup.addKey(new TerminalKeyGroup.TerminalKey("pwd", "pwd\n"));
        linuxGroup.addKey(new TerminalKeyGroup.TerminalKey("top", "top\n"));
        linuxGroup.addKey(new TerminalKeyGroup.TerminalKey("df -h", "df -h\n"));
        linuxGroup.addKey(new TerminalKeyGroup.TerminalKey("free -m", "free -m\n"));
        linuxGroup.addKey(new TerminalKeyGroup.TerminalKey("ps aux", "ps aux\n"));
        
        // Docker命令组
        TerminalKeyGroup dockerGroup = new TerminalKeyGroup();
        dockerGroup.setId(UUID.randomUUID().toString());
        dockerGroup.setName("Docker命令");
        
        dockerGroup.addKey(new TerminalKeyGroup.TerminalKey("docker ps", "docker ps\n"));
        dockerGroup.addKey(new TerminalKeyGroup.TerminalKey("docker images", "docker images\n"));
        dockerGroup.addKey(new TerminalKeyGroup.TerminalKey("docker-compose up", "docker-compose up -d\n"));
        dockerGroup.addKey(new TerminalKeyGroup.TerminalKey("docker-compose down", "docker-compose down\n"));
        
        keyGroups.add(linuxGroup);
        keyGroups.add(dockerGroup);
        
        saveConfigs();
    }
    
    /**
     * 从文件加载配置
     */
    public void loadConfigs() {
        File configFile = new File(CONFIG_FILE_PATH);
        if (configFile.exists()) {
            try {
                keyGroups = objectMapper.readValue(configFile, new TypeReference<List<TerminalKeyGroup>>() {});
            } catch (IOException e) {
                e.printStackTrace();
                keyGroups = new ArrayList<>();
            }
        }
    }
    
    /**
     * 保存配置到文件
     */
    public void saveConfigs() {
        try {
            objectMapper.writeValue(new File(CONFIG_FILE_PATH), keyGroups);
        } catch (IOException e) {
            e.printStackTrace();
        }
    }
    
    /**
     * 获取所有按键组配置
     * @return 按键组配置列表
     */
    public List<TerminalKeyGroup> getAllKeyGroups() {
        return keyGroups;
    }
    
    /**
     * 根据ID获取按键组配置
     * @param id 配置ID
     * @return 按键组配置，如果不存在则返回null
     */
    public TerminalKeyGroup getKeyGroupById(String id) {
        return keyGroups.stream()
                .filter(group -> group.getId().equals(id))
                .findFirst()
                .orElse(null);
    }
    
    /**
     * 添加新的按键组配置
     * @param keyGroup 按键组配置
     * @return 添加后的配置（包含生成的ID）
     */
    public TerminalKeyGroup addKeyGroup(TerminalKeyGroup keyGroup) {
        // 生成唯一ID
        keyGroup.setId(UUID.randomUUID().toString());
        keyGroups.add(keyGroup);
        saveConfigs();
        return keyGroup;
    }
    
    /**
     * 更新按键组配置
     * @param keyGroup 更新后的配置
     * @return 更新是否成功
     */
    public boolean updateKeyGroup(TerminalKeyGroup keyGroup) {
        for (int i = 0; i < keyGroups.size(); i++) {
            if (keyGroups.get(i).getId().equals(keyGroup.getId())) {
                keyGroups.set(i, keyGroup);
                saveConfigs();
                return true;
            }
        }
        return false;
    }
    
    /**
     * 删除按键组配置
     * @param id 配置ID
     * @return 删除是否成功
     */
    public boolean deleteKeyGroup(String id) {
        boolean removed = keyGroups.removeIf(group -> group.getId().equals(id));
        if (removed) {
            saveConfigs();
        }
        return removed;
    }
}