
        document.addEventListener('DOMContentLoaded', () => {
            // Show floating train reminder if there are pending changes on load
            if (isDataChanged) { 
                showTrainBanner();
            }
        });
    