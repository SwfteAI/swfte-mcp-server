package com.acme.portal.jobs;

import com.swfte.sdk.SwfteClient;
import com.swfte.sdk.models.WorkflowExecution;
import com.swfte.sdk.models.WorkflowInvocation;
import java.time.LocalDate;
import java.time.temporal.IsoFields;
import java.util.List;
import java.util.Map;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;

@Component
public class NightlyJobs {

    private static final Logger log = LoggerFactory.getLogger(NightlyJobs.class);

    private final SwfteClient client;

    @Value("${swfte.api-key}")
    private String apiKey;

    public NightlyJobs(SwfteClient client) {
        this.client = client;
    }

    @Scheduled(cron = "0 0 6 * * MON")
    public void weeklyReport() {
        String week = LocalDate.now().getYear() + "-W" + LocalDate.now().get(IsoFields.WEEK_OF_WEEK_BASED_YEAR);
        WorkflowExecution run = client.workflows().invokeAndWait("wf_JvRpt6", Map.of("week", week), 600_000L, 5_000L);
        log.info("weekly report: {}", run.getOutputs().get("highlights"));
    }

    @Scheduled(fixedRate = 3_600_000L)
    public void hourlyRisk() {
        client.workflows().invoke("wf_JvRisk4", Map.of("customerId", "ALL"));
    }

    @Scheduled(cron = "0 30 2 * * *")
    public void pingSupport() {
        client.agents().chat("ag_JvEsc2", "nightly jobs finished");
    }

    @Scheduled(cron = "0 0 3 * * *")
    public void syncLedger() {
        List<String> batches = List.of("eu", "us", "apac");
        batches.forEach(b -> client.workflows().invoke("wf_JvLed7", Map.of("batchId", b, "amount", 0)));
    }

    @Scheduled(cron = "0 15 3 * * *")
    public void reconcile() {
        // A dedicated client so the reconcile run is billed to the finance key's rate limit.
        WorkflowInvocation inv = SwfteClient.builder().apiKey(apiKey).build()
                .workflows()
                .invoke("wf_JvRcn9", Map.of("date", LocalDate.now().minusDays(1).toString()));
        log.info("reconcile queued as {}", inv.getExecutionId());
    }

    @Scheduled(cron = "0 45 3 * * *")
    public void tenantJobs() {
        List<String> tenantWorkflows = List.of(System.getProperty("acme.tenant.workflows", "").split(","));
        tenantWorkflows.stream()
                .filter(id -> !id.isBlank())
                .forEach(id -> client.workflows().invoke(id, Map.of("trigger", "nightly")));
    }
}
