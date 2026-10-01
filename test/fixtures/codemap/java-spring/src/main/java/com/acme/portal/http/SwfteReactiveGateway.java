package com.acme.portal.http;

import java.util.Map;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.core.ParameterizedTypeReference;
import org.springframework.http.HttpHeaders;
import org.springframework.stereotype.Component;
import org.springframework.web.reactive.function.client.WebClient;
import reactor.core.publisher.Mono;

@Component
public class SwfteReactiveGateway {

    private static final String SWFTE = "https://api.swfte.com/agents";
    private static final ParameterizedTypeReference<Map<String, Object>> JSON = new ParameterizedTypeReference<>() {};

    private final WebClient webClient;
    private final WebClient swfteApi;

    public SwfteReactiveGateway(WebClient.Builder builder, @Value("${swfte.api-key}") String apiKey) {
        this.webClient = builder.build();
        this.swfteApi = builder.clone()
                .baseUrl(SWFTE)
                .defaultHeader(HttpHeaders.AUTHORIZATION, "Bearer " + apiKey)
                .build();
    }

    public Mono<Map<String, Object>> submitOrder(String orderId) {
        return webClient.post().uri(SWFTE + "/v2/workflows/wf_JvOrd1/invoke")
                .bodyValue(Map.of("orderId", orderId))
                .retrieve()
                .bodyToMono(JSON);
    }

    public Mono<Map<String, Object>> orderRuns() {
        return webClient.get().uri(SWFTE + "/v2/workflows/wf_JvOrd1/executions").retrieve().bodyToMono(JSON);
    }

    public Mono<Map<String, Object>> flagChurn(String customerId) {
        Map<String, Object> body = Map.of("customerId", customerId, "window", "30d");
        return swfteApi.post()
                .uri("/v2/workflows/wf_JvChn3/invoke")
                .bodyValue(body)
                .retrieve()
                .bodyToMono(JSON);
    }
}
