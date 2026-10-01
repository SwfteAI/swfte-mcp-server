package com.acme.portal.service;

import com.swfte.sdk.SwfteClient;
import java.util.Map;

/** Stale build output from an old annotation processor run; not on any source path. */
public class OrderServiceStale {

    private final SwfteClient client;

    public OrderServiceStale(SwfteClient client) {
        this.client = client;
    }

    public String submit(String orderId) {
        return client.workflows().invoke("wf_JvOrd1", Map.of("orderId", orderId)).getExecutionId();
    }
}
