package com.acme.portal.config;

import com.swfte.sdk.SwfteClient;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.web.client.RestTemplate;
import org.springframework.web.reactive.function.client.WebClient;

@Configuration
public class SwfteConfig {

    @Bean
    public SwfteClient swfteClient(@Value("${swfte.api-key}") String apiKey,
                                   @Value("${swfte.workspace-id}") String workspaceId) {
        return SwfteClient.builder()
                .apiKey(apiKey)
                .workspaceId(workspaceId)
                .timeout(60)
                .build();
    }

    @Bean
    public RestTemplate restTemplate() {
        return new RestTemplate();
    }

    @Bean
    public WebClient.Builder webClientBuilder() {
        return WebClient.builder();
    }
}
