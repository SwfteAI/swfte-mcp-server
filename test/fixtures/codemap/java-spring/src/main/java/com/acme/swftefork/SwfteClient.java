package com.acme.swftefork;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.util.Map;
import java.util.stream.Collectors;

/**
 * In-house fork of the Swfte Java SDK 0.9 (before workflows().invoke existed upstream).
 * Kept only for the legacy bridge; new code uses com.swfte.sdk.SwfteClient.
 */
public class SwfteClient {

    private final String baseUrl;
    private final String apiKey;
    private final HttpClient http = HttpClient.newHttpClient();

    public SwfteClient(String baseUrl, String apiKey) {
        this.baseUrl = baseUrl;
        this.apiKey = apiKey;
    }

    public Workflows workflows() {
        return new Workflows();
    }

    public final class Workflows {
        public int invoke(String workflowId, Map<String, Object> inputs) {
            String json = inputs.entrySet().stream()
                    .map(e -> "\"" + e.getKey() + "\":\"" + e.getValue() + "\"")
                    .collect(Collectors.joining(",", "{", "}"));
            HttpRequest request = HttpRequest.newBuilder(URI.create(baseUrl + "/v2/workflows/" + workflowId + "/invoke"))
                    .header("Authorization", "Bearer " + apiKey)
                    .POST(HttpRequest.BodyPublishers.ofString(json))
                    .build();
            try {
                return http.send(request, HttpResponse.BodyHandlers.discarding()).statusCode();
            } catch (java.io.IOException e) {
                throw new IllegalStateException(e);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                throw new IllegalStateException(e);
            }
        }
    }
}
