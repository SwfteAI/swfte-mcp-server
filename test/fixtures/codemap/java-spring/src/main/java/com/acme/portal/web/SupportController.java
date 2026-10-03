package com.acme.portal.web;

import com.swfte.sdk.SwfteClient;
import com.swfte.sdk.models.AgentChatOptions;
import java.security.Principal;
import java.util.Map;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/api/support")
public class SupportController {

    public record Ask(String message) {
    }

    private final SwfteClient client;

    @Value("${swfte.agents.support}")
    private String supportAgentId;

    public SupportController(SwfteClient client) {
        this.client = client;
    }

    @PostMapping("/ask")
    public Map<String, String> ask(@RequestBody Ask body, Principal principal) {
        String answer = client.agents()
                .chat("ag_JvSup1", body.message(), AgentChatOptions.builder().userId(principal.getName()).build())
                .getResponse();
        return Map.of("answer", answer);
    }

    @PostMapping("/ask-configured")
    public Map<String, String> askConfigured(@RequestBody Ask body) {
        return Map.of("answer", client.agents().chat(supportAgentId, body.message()).getResponse());
    }
}
