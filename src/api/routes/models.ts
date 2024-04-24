import _ from 'lodash';


export default {

    prefix: '/v1',

    get: {
        '/models': async () => {
            return {
                "data": [
                    {
                        "id": "step-v1",
                        "object": "model",
                        "owned_by": "step-free-api"
                    },
                    {
                        "id": "step-v1-vision",
                        "object": "model",
                        "owned_by": "step-free-api"
                    }
                ]
            };
        }

    }

}