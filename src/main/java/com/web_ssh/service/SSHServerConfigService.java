package com.web_ssh.service;

import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.web_ssh.model.SSHServerConfig;
import org.springframework.stereotype.Service;

import jakarta.annotation.PostConstruct;
import java.io.File;
import java.io.IOException;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;
import java.util.stream.Collectors;

/**
 * SSH服务器配置服务类
 * 负责管理SSH服务器配置的保存和读取
 */
@Service
public class SSHServerConfigService {

    private static final String CONFIG_FILE_PATH = "ssh_server_configs.json";
    private final ObjectMapper objectMapper = new ObjectMapper();
    private List<SSHServerConfig> serverConfigs = new ArrayList<>();
    
    /**
     * 初始化方法，在服务启动时加载配置
     */
    @PostConstruct
    public void init() {
        loadConfigs();
    }
    
    /**
     * 从文件加载服务器配置
     */
    public void loadConfigs() {
        File configFile = new File(CONFIG_FILE_PATH);
        if (configFile.exists()) {
            try {
                serverConfigs = objectMapper.readValue(configFile, new TypeReference<List<SSHServerConfig>>() {});
            } catch (IOException e) {
                e.printStackTrace();
                serverConfigs = new ArrayList<>();
            }
        }
    }
    
    /**
     * 保存服务器配置到文件
     */
    public void saveConfigs() {
        try {
            objectMapper.writeValue(new File(CONFIG_FILE_PATH), serverConfigs);
        } catch (IOException e) {
            e.printStackTrace();
        }
    }
    
    /**
     * 获取所有服务器配置
     * @return 服务器配置列表
     */
    public List<SSHServerConfig> getAllConfigs() {
        return serverConfigs;
    }
    
    /**
     * 根据ID获取服务器配置
     * @param id 配置ID
     * @return 服务器配置，如果不存在则返回null
     */
    public SSHServerConfig getConfigById(String id) {
        return serverConfigs.stream()
                .filter(config -> config.getId().equals(id))
                .findFirst()
                .orElse(null);
    }
    
    /**
     * 添加新的服务器配置
     * @param config 服务器配置
     * @return 添加后的配置（包含生成的ID）
     */
    public SSHServerConfig addConfig(SSHServerConfig config) {
        // 生成唯一ID
        config.setId(UUID.randomUUID().toString());
        serverConfigs.add(config);
        saveConfigs();
        return config;
    }
    
    /**
     * 更新服务器配置
     * @param config 更新后的配置
     * @return 更新是否成功
     */
    public boolean updateConfig(SSHServerConfig config) {
        for (int i = 0; i < serverConfigs.size(); i++) {
            if (serverConfigs.get(i).getId().equals(config.getId())) {
                serverConfigs.set(i, config);
                saveConfigs();
                return true;
            }
        }
        return false;
    }
    
    /**
     * 删除服务器配置
     * @param id 配置ID
     * @return 删除是否成功
     */
    public boolean deleteConfig(String id) {
        boolean removed = serverConfigs.removeIf(config -> config.getId().equals(id));
        if (removed) {
            saveConfigs();
        }
        return removed;
    }
    
    /**
     * 搜索服务器配置
     * @param keyword 关键字
     * @return 匹配的服务器配置列表
     */
    public List<SSHServerConfig> searchConfigs(String keyword) {
        if (keyword == null || keyword.isEmpty()) {
            return getAllConfigs();
        }
        
        String lowerKeyword = keyword.toLowerCase();
        return serverConfigs.stream()
                .filter(config -> 
                    config.getName().toLowerCase().contains(lowerKeyword) ||
                    config.getHost().toLowerCase().contains(lowerKeyword) ||
                    config.getUsername().toLowerCase().contains(lowerKeyword) ||
                    (config.getDescription() != null && config.getDescription().toLowerCase().contains(lowerKeyword))
                )
                .collect(Collectors.toList());
    }
}