import _ from 'lodash';

import Request from '@/lib/request/Request.ts';
import chat from '@/api/controllers/chat.ts';

export default {

    prefix: '/token',

    post: {

        '/check': async (request: Request) => {
            request
                .validate('body.token', _.isString)
            const live = await chat.getTokenLiveStatus(request.body.token);
            return {
                live
            }
        }

    }

}