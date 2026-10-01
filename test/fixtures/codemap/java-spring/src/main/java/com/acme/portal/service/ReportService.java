package com.acme.portal.service;

import static java.util.Map.entry;

import com.swfte.sdk.SwfteClient;
import com.swfte.sdk.models.WorkflowExecution;
import java.util.List;
import java.util.Map;
import java.util.stream.Collectors;
import org.springframework.stereotype.Service;
import reactor.core.publisher.Mono;

@Service
public class ReportService {

    private final SwfteClient client;

    public ReportService(SwfteClient client) {
        this.client = client;
    }

    public String weeklySummary(String week) {
        WorkflowExecution run = client.workflows().invokeAndWait("wf_JvRpt6", Map.of("week", week));
        return String.valueOf(run.getOutputs().get("summary"));
    }

    public String queueRegional(String week, String region) {
        return client.workflows()
                .invoke("wf_JvRpt6", Map.ofEntries(entry("week", week), entry("region", region)))
                .getExecutionId();
    }

    public List<String> runIds() {
        return client.workflows().getExecutionHistory("wf_JvRpt6").stream()
                .map(WorkflowExecution::getId)
                .collect(Collectors.toList());
    }

    public Mono<WorkflowExecution> weeklyAsync(String week) {
        return Mono.fromCallable(() -> client.workflows().invokeAndWait("wf_JvRpt6", Map.of("week", week)));
    }

    public String customReport(String week) {
        String workflowId = System.getenv("SWFTE_REPORT_WF");
        return client.workflows().invoke(workflowId, Map.of("week", week)).getExecutionId();
    }
}
