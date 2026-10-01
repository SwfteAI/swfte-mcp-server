package com.acme.portal.web;

import com.swfte.sdk.SwfteClient;
import java.util.Map;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/api/reports")
public class ReportController {

    private final SwfteClient client;

    public ReportController(SwfteClient client) {
        this.client = client;
    }

    @GetMapping("/weekly")
    public Map<String, Object> weekly(@RequestParam String week) {
        return client.workflows().invokeAndWait("wf_JvRpt6", Map.of("week", week)).getOutputs();
    }

    @GetMapping("/contract-risk")
    public Object contractRisk(@RequestParam String url) {
        return client.workflows().invokeAndWait("wf_JvCtr3", Map.of("documentUrl", url, "jurisdiction", "UK")).getOutputs().get("risk");
    }
}
