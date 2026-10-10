package com.web_ssh.config;

import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.web.socket.config.annotation.EnableWebSocket;
import org.springframework.web.socket.config.annotation.WebSocketConfigurer;
import org.springframework.web.socket.config.annotation.WebSocketHandlerRegistry;
import org.springframework.web.socket.server.standard.ServletServerContainerFactoryBean;
import org.springframework.web.socket.server.support.HttpSessionHandshakeInterceptor;
import org.springframework.web.socket.config.annotation.WebSocketTransportRegistration;

/**
 * WebSocket 配置类
 *
 * 配置 SSH 远程终端 + SFTP 文件管理器的 WebSocket 处理器。
 *
 * SSH 远程终端 + SFTP 文件管理器的 WebSocket 处理器。
 */
@Configuration
@EnableWebSocket
public class WebSocketConfig implements WebSocketConfigurer {
    
    @Bean
    public SSHWebSocketHandler sshWebSocketHandler() {
        return new SSHWebSocketHandler();
    }
    
    @Bean
    public ServletServerContainerFactoryBean createWebSocketContainer() {
        ServletServerContainerFactoryBean container = new ServletServerContainerFactoryBean();
        // 设置消息缓冲区大小
        container.setMaxTextMessageBufferSize(1024 * 1024 * 20); // 20MB
        container.setMaxBinaryMessageBufferSize(1024 * 1024 * 20); // 20MB
        container.setAsyncSendTimeout(60000L); // 60秒发送超时(long类型)
        return container;
    }
    
    @Override
    public void registerWebSocketHandlers(WebSocketHandlerRegistry registry) {
        // 注册SSH WebSocket处理器，允许跨域请求
        registry.addHandler(sshWebSocketHandler(), "/ssh-connect")
                .setAllowedOriginPatterns("*")  // 使用setAllowedOriginPatterns代替setAllowedOrigins
                .addInterceptors(new HttpSessionHandshakeInterceptor());
    }
    
    /**
     * 配置WebSocket传输选项
     */
    @Bean
    public WebSocketTransportRegistration webSocketTransportRegistration() {
        return new WebSocketTransportRegistration()
                .setMessageSizeLimit(1024 * 1024 * 10) // 10MB消息大小限制
                .setSendBufferSizeLimit(1024 * 1024 * 20) // 20MB发送缓冲区大小
                .setSendTimeLimit(30000); // 30秒发送超时
    }
}
