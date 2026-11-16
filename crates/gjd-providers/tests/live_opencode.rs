mod support;

use gjd_providers::OpenCode;

#[tokio::test]
#[ignore = "runs the real OpenCode CLI; set GUIJAM_LIVE_MODEL to a provider/model"]
async fn r1_request_returns_variants_that_target_only_the_selected_file() {
    support::variants_target_only_the_selected_file(&OpenCode).await;
}

#[tokio::test]
#[ignore = "runs the real OpenCode CLI; set GUIJAM_LIVE_MODEL to a provider/model"]
async fn read_only_run_cannot_change_project_files_even_when_asked_to() {
    support::read_only_run_cannot_change_project_files(&OpenCode).await;
}

#[tokio::test]
#[ignore = "runs the real OpenCode CLI; set GUIJAM_LIVE_MODEL to a provider/model"]
async fn cancelling_terminates_the_provider_process_group_within_three_seconds() {
    support::cancelling_stops_the_process_group_within_three_seconds(&OpenCode).await;
}
