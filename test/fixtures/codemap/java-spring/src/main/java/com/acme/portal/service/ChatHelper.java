package com.acme.portal.service;

import com.swfte.sdk.SwfteClient;
import com.swfte.sdk.models.AgentChatOptions;
import org.springframework.stereotype.Component;

/** Thin overloads the controllers use; every overload talks to the support agent. */
@Component
public class ChatHelper {

    private static final String SUPPORT_AGENT = "ag_JvSup1";

    private final SwfteClient client;

    public ChatHelper(SwfteClient client) {
        this.client = client;
    }

    public String send(String message, String userId) {
        return client.agents().chat(SUPPORT_AGENT, message, AgentChatOptions.builder().userId(userId).build()).getResponse();
    }

    public String send(String message, String userId, String conversationId) {
        AgentChatOptions options = AgentChatOptions.builder().userId(userId).conversationId(conversationId).build();
        return client.agents().chat("ag_JvSup1", message, options).getResponse();
    }
}
