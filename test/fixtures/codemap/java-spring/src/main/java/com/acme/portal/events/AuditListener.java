package com.acme.portal.events;

import com.swfte.sdk.SwfteClient;
import java.util.Map;
import org.springframework.context.event.EventListener;
import org.springframework.stereotype.Component;

@Component
public class AuditListener {

    public record OrderPlaced(String orderId, double total) {
    }

    private final SwfteClient client;

    public AuditListener(SwfteClient client) {
        this.client = client;
    }

    @EventListener
    public void onOrderPlaced(OrderPlaced event) {
        client.workflows().invoke("wf_JvAud9", Map.of("orderId", event.orderId(), "total", event.total()));
    }
}
