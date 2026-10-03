package com.acme.portal.http;

import java.io.IOException;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;

/** java.net.http calls used by the batch importer (no Spring web stack in that process). */
@Component
public class SwfteJdkGateway {

    private static final String SWFTE = "https://api.swfte.com/agents";

    private final HttpClient http = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(10)).build();

    @Value("${swfte.api-key}")
    private String apiKey;

    public int askSupport(String userId, String json) throws IOException, InterruptedException {
        HttpRequest request = HttpRequest.newBuilder(URI.create(SWFTE + "/v1/agents/ag_JvSup1/chat/" + userId))
                .header("Authorization", "Bearer " + apiKey)
                .header("Content-Type", "application/json")
                .POST(HttpRequest.BodyPublishers.ofString(json))
                .build();
        return http.send(request, HttpResponse.BodyHandlers.ofString()).statusCode();
    }

    public int askPortalHelp(String json, String embedKey) throws IOException, InterruptedException {
        return http.send(HttpRequest.newBuilder(URI.create("https://api.swfte.com/agents/v1/public/agents/ag_JvPub5/chat"))
                        .header("Content-Type", "application/json")
                        .header("X-Swfte-Embed-Key", embedKey)
                        .POST(HttpRequest.BodyPublishers.ofString(json))
                        .build(),
                HttpResponse.BodyHandlers.ofString()).statusCode();
    }

    public int postLedger(String json) throws IOException, InterruptedException {
        HttpRequest request = HttpRequest.newBuilder()
                .uri(URI.create(SWFTE + "/v2/workflows/wf_JvLed7/invoke"))
                .header("Authorization", "Bearer " + apiKey)
                .POST(HttpRequest.BodyPublishers.ofString(json))
                .build();
        return http.send(request, HttpResponse.BodyHandlers.ofString()).statusCode();
    }

    public int escalate(String userId, String json) throws IOException, InterruptedException {
        String agent = System.getenv("SWFTE_ESCALATION_AGENT_ID");
        HttpRequest request = HttpRequest.newBuilder(URI.create(SWFTE + "/v1/agents/" + agent + "/chat/" + userId))
                .header("Authorization", "Bearer " + apiKey)
                .POST(HttpRequest.BodyPublishers.ofString(json))
                .build();
        return http.send(request, HttpResponse.BodyHandlers.ofString()).statusCode();
    }
}
