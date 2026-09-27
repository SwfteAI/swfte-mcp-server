package com.acme.portal.service;

import com.swfte.sdk.SwfteClient;
import com.swfte.sdk.models.AgentChatOptions;
import org.springframework.stereotype.Service;

@Service
public class KnowledgeService {

    private final SwfteClient client;

    public KnowledgeService(SwfteClient client) {
        this.client = client;
    }

    public String ask(String question, String userId) {
        return client.agents()
                .chat("ag_JvDocs", question, AgentChatOptions.builder().userId(userId).build())
                .getResponse();
    }

    // Old path: client.agents().chat("ag_JvOldKb", question) -- the KB agent was merged into ag_JvDocs.
    public String askAnonymous(String question) {
        return client.agents().chat("ag_JvDocs", question).getResponse();
    }
}
