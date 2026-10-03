package com.acme.portal.support;

/** URLs shown on the admin page. Nothing here sends a request. */
public final class Links {

    public static final String ORDER_WORKFLOW_API = "https://api.swfte.com/agents/v2/workflows/wf_JvOrd1/invoke";
    public static final String SUPPORT_CHAT_PAGE = "https://app.swfte.com/chat/ag_JvSup1";

    private Links() {
    }

    public static String describe() {
        return "Orders run on " + ORDER_WORKFLOW_API + "; customers chat at " + SUPPORT_CHAT_PAGE;
    }
}
