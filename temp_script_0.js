
        const adminToken = localStorage.getItem('bps_admin_token');
        if (!adminToken) window.location.replace('/error?code=403');
    