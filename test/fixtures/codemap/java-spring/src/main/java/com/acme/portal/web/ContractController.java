package com.acme.portal.web;

import com.swfte.sdk.SwfteClient;
import com.swfte.sdk.models.AgentChatOptions;
import java.util.Map;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/api/contracts")
public class ContractController {

    public record ReviewRequest(String url, String jurisdiction, String question) {
    }

    private final SwfteClient client;

    public ContractController(SwfteClient client) {
        this.client = client;
    }

    @PostMapping("/review")
    public Map<String, String> review(@RequestBody ReviewRequest req) {
        Map<String, Object> inputs = Map.of("documentUrl", req.url(), "jurisdiction", req.jurisdiction());
        return Map.of("executionId", client.workflows().invoke("wf_JvCtr3", inputs).getExecutionId());
    }

    @PostMapping("/explain")
    public Map<String, String> explain(@RequestBody ReviewRequest req) {
        AgentChatOptions options = AgentChatOptions.builder().userId("contracts").build();
        return Map.of("answer", client.agents().chat("ag_JvDocs", req.question(), options).getResponse());
    }
}
