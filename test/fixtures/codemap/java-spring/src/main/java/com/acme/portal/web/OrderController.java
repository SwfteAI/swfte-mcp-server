package com.acme.portal.web;

import com.acme.portal.service.OrderService;
import com.swfte.sdk.SwfteClient;
import com.swfte.sdk.models.WorkflowExecution;
import java.util.List;
import java.util.Map;
import java.util.stream.Collectors;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/api/orders")
public class OrderController {

    public record OrderRequest(String id, String sku) {
    }

    private final SwfteClient client;
    private final OrderService orders;

    public OrderController(SwfteClient client, OrderService orders) {
        this.client = client;
        this.orders = orders;
    }

    @PostMapping
    public Map<String, String> create(@RequestBody OrderRequest req) {
        String executionId = client.workflows().invoke("wf_JvOrd1", Map.of("orderId", req.id(), "sku", req.sku())).getExecutionId();
        return Map.of("executionId", executionId);
    }

    @GetMapping("/{id}/runs")
    public List<String> runs(@PathVariable String id) {
        return client.workflows().getExecutionHistory("wf_JvOrd1").stream()
                .map(WorkflowExecution::getId)
                .collect(Collectors.toList());
    }

    @PostMapping("/{id}/track")
    public String track(@PathVariable String id, @RequestBody OrderRequest req) {
        return orders.submitAndTrack(id, req.sku());
    }
}
