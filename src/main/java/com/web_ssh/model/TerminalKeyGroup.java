package com.web_ssh.model;

import java.io.Serializable;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;

/**
 * 终端按键组配置实体类
 */
public class TerminalKeyGroup implements Serializable {
    
    private static final long serialVersionUID = 1L;
    
    private String id;          // 配置ID
    private String name;        // 按键组名称
    private List<TerminalKey> keys; // 按键列表
    
    public TerminalKeyGroup() {
        this.keys = new ArrayList<>();
    }
    
    public TerminalKeyGroup(String id, String name, List<TerminalKey> keys) {
        this.id = id;
        this.name = name;
        this.keys = keys != null ? keys : new ArrayList<>();
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

    public List<TerminalKey> getKeys() {
        return keys;
    }

    public void setKeys(List<TerminalKey> keys) {
        this.keys = keys;
    }
    
    /**
     * 添加按键
     * @param key 按键
     */
    public void addKey(TerminalKey key) {
        if (this.keys == null) {
            this.keys = new ArrayList<>();
        }
        this.keys.add(key);
    }
    
    /**
     * 终端按键实体类
     */
    public static class TerminalKey implements Serializable {
        
        private static final long serialVersionUID = 1L;
        
        private String id;          // 按键ID
        private String label;       // 按键标签
        private String command;     // 按键命令
        private String color;       // 按键颜色
        
        public TerminalKey() {
            this.id = UUID.randomUUID().toString();
            this.color = "#4CAF50"; // 默认绿色
        }
        
        public TerminalKey(String label, String command) {
            this();
            this.label = label;
            this.command = command;
        }
        
        public TerminalKey(String label, String command, String color) {
            this(label, command);
            this.color = color;
        }

        public String getId() {
            return id;
        }

        public void setId(String id) {
            this.id = id;
        }

        public String getLabel() {
            return label;
        }

        public void setLabel(String label) {
            this.label = label;
        }

        public String getCommand() {
            return command;
        }

        public void setCommand(String command) {
            this.command = command;
        }

        public String getColor() {
            return color;
        }

        public void setColor(String color) {
            this.color = color;
        }
    }
}