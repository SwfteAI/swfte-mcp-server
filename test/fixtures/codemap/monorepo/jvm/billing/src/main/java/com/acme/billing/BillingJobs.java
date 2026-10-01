package com.acme.billing;

import com.swfte.sdk.SwfteClient;
import com.swfte.sdk.models.AgentChatResponse;
import com.swfte.sdk.models.WorkflowExecution;
import com.swfte.sdk.models.WorkflowInvocation;
import java.util.List;
import java.util.Map;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Service;
import org.springframework.web.client.RestTemplate;

@Service
public class BillingJobs {

    private static final String SWFTE_API = "https://api.swfte.com/agents";

    private final SwfteClient client = SwfteClient.builder()
            .apiKey(System.getenv("SWFTE_API_KEY"))
            .build();

    private final RestTemplate restTemplate = new RestTemplate();

    @Value("${swfte.billing.dunning-workflow-id}")
    private String dunningWorkflowId;

    /** Triage one supplier invoice. */
    public String charge(String invoiceUrl) {
        WorkflowInvocation inv = client.workflows().invoke("wf_Inv7Tr2", Map.of("invoiceUrl", invoiceUrl, "vendor", "supplier"));
        return inv.getExecutionId();
    }

    /** Same, with an explicit currency for foreign suppliers. */
    public String charge(String invoiceUrl, String currency) {
        WorkflowInvocation inv = client.workflows().invoke("wf_Inv7Tr2",
                Map.of("invoiceUrl", invoiceUrl, "vendor", "supplier", "currency", currency));
        return inv.getExecutionId();
    }

    public Object leadScore(String email) {
        WorkflowExecution done = client.workflows().invokeAndWait("wf_Lead5Q", Map.of("email", email), 60_000, 2_000);
        return done.getOutputs().get("score");
    }

    @Scheduled(cron = "0 0 6 * * *")
    public void morningDrafts() {
        List<WorkflowExecution> runs = client.workflows().getExecutionHistory("wf_8K2mQ4");
        System.out.println("draft runs: " + runs.size());
    }

    @Scheduled(cron = "0 0 7 * * *")
    public void dunning() {
        client.workflows().invoke(dunningWorkflowId, Map.of("daysOverdue", 30));
    }

    public String pricingAnswer(String question) {
        AgentChatResponse reply = client.agents().chat("ag_Sales3K", question);
        return reply.getResponse();
    }

    @SuppressWarnings("unchecked")
    public int legacyTriage(String invoiceUrl) {
        Map<String, Object> res = restTemplate.postForObject(
                SWFTE_API + "/v2/workflows/wf_Inv7Tr2/invoke",
                Map.of("invoiceUrl", invoiceUrl, "vendor", "legacy"),
                Map.class);
        return res == null ? 0 : res.size();
    }
}
