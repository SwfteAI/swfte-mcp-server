package com.acme.portal.service;

import com.swfte.sdk.SwfteClient;
import com.swfte.sdk.models.ChatFlowSession;
import java.util.Map;
import org.springframework.stereotype.Service;

@Service
public class IntakeService {

    private final SwfteClient client;

    public IntakeService(SwfteClient client) {
        this.client = client;
    }

    public String openWebSession() {
        ChatFlowSession session = client.chatflows().startSession("cf_JvInt5", null);
        return session.getSessionId();
    }

    public String openReturnSession(String orderId) {
        ChatFlowSession session = client.chatflows().startSession("cf_JvInt5", Map.of("orderId", orderId));
        return session.getSessionId();
    }

    public String openFaqSession() {
        return client.chatflows().startSession("cf_JvFaq6", Map.of()).getSessionId();
    }
}
