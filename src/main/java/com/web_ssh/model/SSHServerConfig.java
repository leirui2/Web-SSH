package com.web_ssh.model;

import java.io.Serializable;

/**
 * SSH服务器配置实体类
 */
public class SSHServerConfig implements Serializable {
    
    private static final long serialVersionUID = 1L;
    
    private String id;          // 配置ID
    private String name;        // 服务器名称
    private String host;        // 主机地址
    private int port;           // 端口号
    private String username;    // 用户名
    private String password;    // 密码
    private String description; // 描述信息
    
    public SSHServerConfig() {
        this.port = 22; // 默认SSH端口
    }
    
    public SSHServerConfig(String id, String name, String host, int port, String username, String password, String description) {
        this.id = id;
        this.name = name;
        this.host = host;
        this.port = port;
        this.username = username;
        this.password = password;
        this.description = description;
    }

    public String getId() {
        return id;
    }

    public void setId(String id) {
        this.id = id;
    }

    public String getName() {
        return name;
    }

    public void setName(String name) {
        this.name = name;
    }

    public String getHost() {
        return host;
    }

    public void setHost(String host) {
        this.host = host;
    }

    public int getPort() {
        return port;
    }

    public void setPort(int port) {
        this.port = port;
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

    public String getDescription() {
        return description;
    }

    public void setDescription(String description) {
        this.description = description;
    }
    
    @Override
    public String toString() {
        return "SSHServerConfig{" +
                "id='" + id + '\'' +
                ", name='" + name + '\'' +
                ", host='" + host + '\'' +
                ", port=" + port +
                ", username='" + username + '\'' +
                ", description='" + description + '\'' +
                '}';
    }
}