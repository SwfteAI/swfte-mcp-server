package com.acme.portal.web;

import com.acme.portal.config.SwfteIds;
import com.swfte.sdk.SwfteClient;
import com.swfte.sdk.models.WorkflowExecution;
import java.util.Map;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/api/billing")
public class BillingController {

    private final SwfteClient client;
    private final SwfteIds ids;

    public BillingController(SwfteClient client, SwfteIds ids) {
        this.client = client;
        this.ids = ids;
    }

    @PostMapping("/invoices/{id}/charge")
    public String charge(@PathVariable String id, @RequestParam double amount) {
        return client.workflows().invoke("wf_JvBil8", Map.of("invoiceId", id, "amount", amount)).getExecutionId();
    }

    @PostMapping("/invoices/{id}/charge-sync")
    public boolean chargeAndWait(@PathVariable String id) {
        WorkflowExecution run = client.workflows().invokeAndWait("wf_JvBil8", Map.of("invoiceId", id));
        return Boolean.TRUE.equals(run.getOutputs().get("paid"));
    }

    @PostMapping("/invoices/{id}/charge-tenant")
    public String chargeTenant(@PathVariable String id) {
        return client.workflows().invoke(ids.getBillingWorkflow(), Map.of("invoiceId", id)).getExecutionId();
    }
}
