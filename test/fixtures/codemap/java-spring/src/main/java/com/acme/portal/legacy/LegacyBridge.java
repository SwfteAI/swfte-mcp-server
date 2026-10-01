package com.acme.portal.legacy;

import com.acme.swftefork.SwfteClient;
import java.util.Map;
import org.springframework.stereotype.Component;

/** The 2023 order importer still runs on the in-house SDK fork. */
@Component
public class LegacyBridge {

    private final SwfteClient forkClient = new SwfteClient("https://api.swfte.com/agents", System.getenv("SWFTE_API_KEY"));

    public int importOrder(String orderId) {
        return forkClient.workflows().invoke("wf_JvFork1", Map.of("orderId", orderId));
    }
}
