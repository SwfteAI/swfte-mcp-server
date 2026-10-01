package com.acme.portal.service;

import com.swfte.sdk.SwfteClient;
import com.swfte.sdk.models.WorkflowExecution;
import java.util.Map;
import org.springframework.stereotype.Service;

@Service
public class OnboardingService {

    private final SwfteClient client;

    public OnboardingService(SwfteClient client) {
        this.client = client;
    }

    public String start(String accountId, String plan) {
        return client.workflows().invoke("wf_JvOnb2", Map.of("accountId", accountId, "plan", plan)).getExecutionId();
    }

    public String startAndWelcome(String accountId) {
        WorkflowExecution run = client.workflows().invokeAndWait(
                "wf_JvOnb2",
                Map.of("accountId", accountId, "plan", "trial"),
                300_000L,
                3_000L);
        return (String) run.getOutputs().get("welcomeEmailId");
    }

    public String rehearse(String accountId) {
        return client.workflows().execute("wf_JvOnb2", Map.of("accountId", accountId, "plan", "trial", "testingFlag", true)).getStatusRaw();
    }

    public int runCount() {
        return client.workflows().getExecutionHistory("wf_JvOnb2").size();
    }
}
