package com.acme.portal.service;

import com.acme.portal.domain.OrderRecord;
import com.swfte.sdk.SwfteClient;
import com.swfte.sdk.models.WorkflowExecution;
import com.swfte.sdk.models.WorkflowInvocation;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.stream.Collectors;
import org.springframework.stereotype.Service;

/**
 * Order fulfilment on the {@code wf_JvOrd1} workflow.
 *
 * <p>Typical use: {@code client.workflows().invoke("wf_JvOrd1", Map.of("orderId", id))}.
 */
@Service
public class OrderService {

    private final SwfteClient client;

    public OrderService(SwfteClient client) {
        this.client = client;
    }

    public String submit(String orderId, String sku) {
        WorkflowInvocation invocation = client.workflows().invoke("wf_JvOrd1", Map.of("orderId", orderId, "sku", sku));
        return invocation.getExecutionId();
    }

    public String submitAndTrack(String orderId, String sku) {
        WorkflowExecution execution = client.workflows().invokeAndWait("wf_JvOrd1", Map.of("orderId", orderId, "sku", sku), 120_000L, 2_000L);
        return (String) execution.getOutputs().get("trackingNumber");
    }

    public String submitPriority(String orderId) {
        Map<String, Object> inputs = Map.of("orderId", orderId, "priority", "HIGH");
        return client.workflows().invoke("wf_JvOrd1", inputs).getExecutionId();
    }

    public String submitWithNotes(OrderRecord order) {
        Map<String, Object> inputs = new HashMap<>();
        inputs.put("orderId", order.id());
        if (order.notes() != null) {
            inputs.put("notes", order.notes());
        }
        return client.workflows().invoke("wf_JvOrd1", inputs).getExecutionId();
    }

    public List<String> recentStatuses() {
        return client.workflows().getExecutionHistory("wf_JvOrd1").stream()
                .map(WorkflowExecution::getStatusRaw)
                .collect(Collectors.toList());
    }

    public CompletableFuture<String> submitAsync(String orderId) {
        return CompletableFuture.supplyAsync(() -> client.workflows().invoke("wf_JvOrd1", Map.of("orderId", orderId)))
                .thenApply(WorkflowInvocation::getExecutionId);
    }

    public String dryRun(String orderId) {
        WorkflowExecution execution = client.workflows().execute("wf_JvOrd1", Map.of("orderId", orderId, "testingFlag", true));
        return execution.getStatusRaw();
    }

    public String submitStored(OrderRecord order) {
        return client.workflows().invoke(order.workflowId(), Map.of("orderId", order.id())).getExecutionId();
    }
}
